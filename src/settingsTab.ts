import { App, Notice, PluginSettingTab, Setting, type DropdownComponent } from "obsidian";
import type PrivateSyncPlugin from "./plugin";
import type { DeviceType, ServerVault } from "./types";

export class PrivateSyncSettingTab extends PluginSettingTab {
  private pairingPassword = "";
  private recoveryPairingCode = "";
  private newVaultName = "";
  private deviceNameSyncTimer: number | null = null;

  constructor(app: App, private readonly plugin: PrivateSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    if (!this.pairingPassword) this.pairingPassword = this.plugin.settings.password;

    new Setting(containerEl)
      .setName("Server URL")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:8787")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Device name")
      .addText((text) =>
        text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
          this.plugin.settings.deviceName = value;
          await this.plugin.saveSettings();
          this.scheduleDeviceNameSync(value.trim());
        })
      );

    new Setting(containerEl)
      .setName("Device type")
      .addDropdown((dropdown) => {
        for (const type of ["desktop", "mobile", "tablet", "unknown"] as DeviceType[]) dropdown.addOption(type, type);
        dropdown.setValue(this.plugin.settings.deviceType).onChange(async (value) => {
          this.plugin.settings.deviceType = value as DeviceType;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Pairing password")
      .addText((text) =>
        text
          .setValue(this.pairingPassword)
          .onChange(async (value) => {
            this.pairingPassword = value;
            this.plugin.settings.password = value;
            await this.plugin.saveSettings();
          })
      )
      .then((setting) => {
        const text = setting.controlEl.querySelector("input");
        if (text) text.type = "password";
      });

    new Setting(containerEl)
      .setName("Recovery pairing code")
      .setDesc("Optional one-time code from syncctl pairing-code create. It does not replace the server password.")
      .addText((text) =>
        text
          .setPlaceholder("optional")
          .setValue(this.recoveryPairingCode)
          .onChange((value) => {
            this.recoveryPairingCode = value.trim();
          })
      );

    new Setting(containerEl)
      .setName("Test server password")
      .setDesc("Checks this Server URL and the current Pairing password without pairing a device.")
      .addButton((button) =>
        button.setButtonText("Test").setClass("private-sync-button").setClass("private-sync-button-subtle").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Testing...");
          try {
            await this.testPassword();
            new Notice("Private Sync: server password is valid.", 8000);
          } catch (error) {
            new Notice(`Private Sync password test failed: ${errorMessage(error)}`, 10000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("Test");
          }
        })
      );

    new Setting(containerEl)
      .setName("Pair this device")
      .addButton((button) =>
        button.setButtonText("Pair").setClass("private-sync-button").setClass("private-sync-button-primary").setCta().onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Pairing...");
          try {
            await this.plugin.syncEngine.pairDevice({
              password: this.pairingPassword,
              recoveryPairingCode: this.recoveryPairingCode || undefined
            });
            this.pairingPassword = "";
            this.recoveryPairingCode = "";
            this.display();
          } catch (error) {
            new Notice(`Private Sync pairing failed: ${errorMessage(error)}`, 10000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("Pair");
          }
        })
      );

    this.renderVaultSettings(containerEl);

    new Setting(containerEl)
      .setName("Auto sync")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync attachments")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncAttachments).onChange(async (value) => {
          this.plugin.settings.syncAttachments = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync Obsidian settings")
      .setDesc("Synchronizes note creator settings only, including daily notes, templates, unique note creator, and Zettelkasten prefixer paths/formats.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncObsidianSettings).onChange(async (value) => {
          this.plugin.settings.syncObsidianSettings = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Sync community plugins")
      .setDesc("Synchronizes community plugin folders only when a plugin with the same ID is missing on the other side.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncCommunityPlugins).setDisabled(!this.plugin.settings.syncObsidianSettings).onChange(async (value) => {
          this.plugin.settings.syncCommunityPlugins = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Max automatic file size")
      .setDesc("Files above this size are indexed as ignored and are not uploaded automatically.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxAutoSyncFileSizeMb)).onChange(async (value) => {
          this.plugin.settings.maxAutoSyncFileSizeMb = Number(value) || 0;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Large file threshold")
      .setDesc("Files at or above this size use chunked transfer.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.largeFileThresholdMb)).onChange(async (value) => {
          this.plugin.settings.largeFileThresholdMb = Number(value) || 0;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Chunk size")
      .setDesc("Upload and download chunk size in MB.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.largeFileChunkSizeMb)).onChange(async (value) => {
          this.plugin.settings.largeFileChunkSizeMb = Number(value) || 1;
          await this.plugin.saveSettings();
        })
      );
  }

  private async testPassword(): Promise<void> {
    if (!this.plugin.settings.serverUrl.trim()) {
      throw new Error("Enter the Private Sync server URL first.");
    }
    if (!this.pairingPassword.trim()) {
      throw new Error("Enter the pairing password first.");
    }
    await this.plugin.api.serverInfo();
    await this.plugin.api.login(this.pairingPassword);
  }

  private scheduleDeviceNameSync(name: string): void {
    if (this.deviceNameSyncTimer !== null) {
      window.clearTimeout(this.deviceNameSyncTimer);
      this.deviceNameSyncTimer = null;
    }
    if (!this.plugin.settings.deviceToken) return;
    this.deviceNameSyncTimer = window.setTimeout(() => {
      this.deviceNameSyncTimer = null;
      this.syncDeviceName(name).catch((error) => {
        new Notice(`Private Sync: device name was saved locally but not on server: ${errorMessage(error)}`, 10000);
      });
    }, 800);
  }

  private async syncDeviceName(name: string): Promise<void> {
    if (!this.plugin.settings.deviceToken) return;
    if (name !== this.plugin.settings.deviceName.trim()) return;
    if (!name) throw new Error("Device name cannot be empty.");
    await this.plugin.api.updateCurrentDevice({ name });
    this.plugin.refreshView();
  }

  private renderVaultSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Server vault")
      .setDesc(this.plugin.settings.vaultLinked ? `Linked to ${this.plugin.settings.vaultId}` : "Choose the server vault before linking this local vault.")
      .addDropdown((dropdown) => {
        dropdown.addOption(this.plugin.settings.vaultId, this.plugin.settings.vaultId);
        dropdown.setValue(this.plugin.settings.vaultId);
        dropdown.setDisabled(this.plugin.settings.vaultLinked);
        dropdown.onChange(async (value) => {
          try {
            await this.selectVault(value);
          } catch (error) {
            new Notice(`Private Sync: cannot select vault: ${errorMessage(error)}`, 10000);
          } finally {
            this.display();
          }
        });
        this.loadVaultOptions(dropdown).catch((error) => {
          if (this.plugin.settings.deviceToken) new Notice(`Private Sync: cannot load vaults: ${errorMessage(error)}`, 10000);
        });
      })
      .addButton((button) =>
        button.setButtonText("Refresh").setClass("private-sync-button").setClass("private-sync-button-subtle").onClick(() => {
          this.display();
        })
      )
      .addButton((button) =>
        button
          .setButtonText(this.plugin.settings.vaultLinked ? "Linked" : "Link")
          .setClass("private-sync-button")
          .setClass("private-sync-button-primary")
          .setCta()
          .setDisabled(!this.plugin.settings.deviceToken || this.plugin.settings.vaultLinked)
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Checking...");
            try {
              await this.plugin.syncEngine.finishInitialVaultConnection();
              this.display();
            } catch (error) {
              new Notice(`Private Sync: cannot link vault: ${errorMessage(error)}`, 10000);
            } finally {
              button.setButtonText(this.plugin.settings.vaultLinked ? "Linked" : "Link");
              button.setDisabled(!this.plugin.settings.deviceToken || this.plugin.settings.vaultLinked);
            }
          })
      );

    new Setting(containerEl)
      .setName("Create server vault")
      .setDesc("Creates an empty server vault, selects it, and starts the first-link safety check.")
      .addText((text) =>
        text
          .setPlaceholder("Vault name")
          .setValue(this.newVaultName)
          .onChange((value) => {
            this.newVaultName = value;
          })
      )
      .addButton((button) =>
        button.setButtonText("Create").setClass("private-sync-button").setClass("private-sync-button-primary").setDisabled(!this.plugin.settings.deviceToken || this.plugin.settings.vaultLinked).onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Creating...");
          try {
            const vault = await this.createVault();
            this.newVaultName = "";
            new Notice(
              this.plugin.settings.vaultLinked ? `Private Sync: created and linked vault ${vault.name}.` : `Private Sync: created vault ${vault.name}.`,
              8000
            );
            this.display();
          } catch (error) {
            new Notice(`Private Sync: cannot create vault: ${errorMessage(error)}`, 10000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("Create");
          }
        })
      );
  }

  private async loadVaultOptions(dropdown: DropdownComponent): Promise<void> {
    if (!this.plugin.settings.deviceToken) return;
    const response = await this.plugin.api.getVaults();
    dropdown.selectEl.replaceChildren();
    const vaults = response.vaults.sort((a, b) => a.name.localeCompare(b.name));
    if (!vaults.some((vault) => vault.id === this.plugin.settings.vaultId)) {
      dropdown.addOption(this.plugin.settings.vaultId, this.plugin.settings.vaultId);
    }
    for (const vault of vaults) {
      dropdown.addOption(vault.id, `${vault.name} (${vault.id})`);
    }
    dropdown.setValue(this.plugin.settings.vaultId);
  }

  private async createVault(): Promise<ServerVault> {
    const name = this.newVaultName.trim();
    if (!name) throw new Error("Enter a vault name first.");
    if (!this.plugin.settings.deviceToken) throw new Error("Pair this device before creating server vaults.");
    if (this.plugin.settings.vaultLinked) throw new Error("This local vault is already linked to a server vault.");
    const vault = await this.plugin.api.createVault({ name });
    this.plugin.settings.vaultId = vault.id;
    await this.plugin.saveSettings();
    await this.plugin.syncEngine.finishInitialVaultConnection();
    return vault;
  }

  private async selectVault(vaultId: string): Promise<void> {
    if (!vaultId || vaultId === this.plugin.settings.vaultId) return;
    if (this.plugin.settings.vaultLinked) throw new Error("This local vault is already linked to a server vault.");
    this.plugin.settings.vaultId = vaultId;
    await this.plugin.saveSettings();
    this.plugin.refreshView();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
