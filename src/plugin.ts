import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { ApiClient } from "./apiClient";
import { DEFAULT_INDEX, DEFAULT_SETTINGS } from "./defaults";
import { LocalIndexStore } from "./localIndex";
import { PrivateSyncSettingTab } from "./settingsTab";
import { SyncEngine } from "./syncEngine";
import { PRIVATE_SYNC_VIEW, PrivateSyncView } from "./statusView";
import type { LocalIndex, PluginSettings } from "./types";

type StoredData = {
  settings?: Partial<PluginSettings>;
  index?: LocalIndex;
};

export default class PrivateSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  indexStore = new LocalIndexStore(this);
  api = new ApiClient(this.settings.serverUrl, () => this.settings.deviceToken);
  syncEngine = new SyncEngine(this, this.indexStore, this.api);
  private socket: WebSocket | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.indexStore.load();
    this.recreateApi();

    this.registerView(PRIVATE_SYNC_VIEW, (leaf: WorkspaceLeaf) => new PrivateSyncView(leaf, this));
    this.addRibbonIcon("refresh-cw", "Private Sync", () => this.activateView());
    this.addSettingTab(new PrivateSyncSettingTab(this.app, this));

    this.addCommand({
      id: "private-sync-now",
      name: "Sync now",
      callback: () => this.syncEngine.syncNow()
    });
    this.addCommand({
      id: "private-sync-pair-device",
      name: "Pair this device",
      callback: () => this.syncEngine.pairDevice()
    });
    this.addCommand({
      id: "private-sync-open-panel",
      name: "Open sync panel",
      callback: () => this.activateView()
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && this.settings.autoSync) this.debouncedSync();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", () => {
        if (this.settings.autoSync) this.debouncedSync();
      })
    );
    this.registerEvent(
      this.app.vault.on("create", () => {
        if (this.settings.autoSync) this.debouncedSync();
      })
    );

    this.connectEvents();
    if (this.settings.autoSync && this.settings.deviceToken) {
      this.registerTimer(() => this.syncEngine.syncNow().catch((error) => new Notice(error.message)), 1000);
    }
  }

  onunload(): void {
    this.socket?.close();
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as StoredData | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
  }

  async saveSettings(): Promise<void> {
    this.recreateApi();
    await this.savePluginData({ settings: this.settings });
  }

  async savePluginData(partial: StoredData): Promise<void> {
    const existing = ((await this.loadData()) as StoredData | null) ?? {};
    await this.saveData({ ...existing, ...partial });
  }

  refreshView(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(PRIVATE_SYNC_VIEW)) {
      const view = leaf.view;
      if (view instanceof PrivateSyncView) view.refresh();
    }
  }

  private recreateApi(): void {
    this.api = new ApiClient(this.settings.serverUrl, () => this.settings.deviceToken);
    this.syncEngine = new SyncEngine(this, this.indexStore, this.api);
  }

  private async activateView(): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: PRIVATE_SYNC_VIEW, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private debouncedSync = debounce(async () => {
    if (!this.settings.deviceToken) return;
    try {
      await this.syncEngine.syncNow();
    } catch (error) {
      new Notice(`Private Sync: ${(error as Error).message}`);
    }
  }, 1500);

  private connectEvents(): void {
    if (!this.settings.deviceToken) return;
    const url = this.settings.serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + `/api/v1/events?token=${encodeURIComponent(this.settings.deviceToken)}`;
    this.socket = new WebSocket(url);
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type?: string };
      if (message.type === "vault_changed" || message.type === "request_created" || message.type === "conflict_created") {
        this.syncEngine.syncNow().catch((error) => new Notice(`Private Sync: ${error.message}`));
      }
      this.refreshView();
    };
    this.socket.onclose = () => {
      this.registerTimer(() => this.connectEvents(), 5000);
    };
  }

  private registerTimer(callback: () => void, delay: number): void {
    const timeout = window.setTimeout(callback, delay);
    this.register(() => window.clearTimeout(timeout));
  }
}

function debounce<T extends (...args: never[]) => void | Promise<void>>(fn: T, delay: number): T {
  let timeout: number | undefined;
  return ((...args: never[]) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => void fn(...args), delay);
  }) as T;
}
