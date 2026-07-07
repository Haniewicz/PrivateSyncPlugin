import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PrivateSyncPlugin from "./plugin";
import type { DeviceType } from "./types";

export class PrivateSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: PrivateSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

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
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value;
            await this.plugin.saveSettings();
          })
      )
      .then((setting) => {
        const text = setting.controlEl.querySelector("input");
        if (text) text.type = "password";
      });

    new Setting(containerEl)
      .setName("Pair this device")
      .addButton((button) =>
        button.setButtonText("Pair").setCta().onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Pairing...");
          try {
            await this.plugin.syncEngine.pairDevice();
            this.display();
          } catch (error) {
            new Notice(`Private Sync pairing failed: ${errorMessage(error)}`, 10000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("Pair");
          }
        })
      );

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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
