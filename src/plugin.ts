import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { ApiClient } from "./apiClient";
import { DEFAULT_INDEX, DEFAULT_SETTINGS } from "./defaults";
import { LocalIndexStore } from "./localIndex";
import { PairingApprovalModal, parseDevicePairingPayload } from "./pairingApprovalModal";
import { PrivateSyncSettingTab } from "./settingsTab";
import { SyncEngine } from "./syncEngine";
import { PRIVATE_SYNC_VIEW, PrivateSyncView } from "./statusView";
import type { LocalIndex, PluginSettings, ServerRequest } from "./types";

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
  private reconnectTimeout: number | null = null;
  private activePairingRequestModals = new Set<string>();
  private unloading = false;

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
    this.addCommand({
      id: "private-sync-check-pairing-requests",
      name: "Check pairing requests",
      callback: () => this.checkPairingRequests()
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

    this.registerMobileLifecycleHandlers();
    this.app.workspace.onLayoutReady(() => this.handleAppBecameActive("layout-ready"));
  }

  onunload(): void {
    this.unloading = true;
    this.clearReconnectTimer();
    this.closeSocket();
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

  async checkPairingRequests(): Promise<void> {
    if (!this.settings.deviceToken || !this.settings.vaultId) return;
    try {
      const response = await this.api.requests(this.settings.vaultId);
      for (const request of response.requests) {
        this.maybeOpenPairingApproval(request);
      }
      this.refreshView();
    } catch (error) {
      new Notice(`Private Sync: cannot load pairing requests: ${(error as Error).message}`, 10000);
    }
  }

  private recreateApi(): void {
    this.api = new ApiClient(this.settings.serverUrl, () => this.settings.deviceToken);
    this.syncEngine = new SyncEngine(this, this.indexStore, this.api);
    this.reconnectEvents();
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

  private registerMobileLifecycleHandlers(): void {
    const onActive = () => this.handleAppBecameActive("app-active");
    const onHidden = () => this.handleAppWentInactive();

    this.registerDomEvent(window, "focus", onActive);
    this.registerDomEvent(window, "pageshow", onActive);
    this.registerDomEvent(window, "online", onActive);
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.handleAppBecameActive("visible");
      } else {
        onHidden();
      }
    });
  }

  private handleAppBecameActive(_reason: string): void {
    if (!this.settings.deviceToken) return;
    this.reconnectEvents();
    this.checkPairingRequests();
    if (this.settings.autoSync) this.debouncedSync();
  }

  private handleAppWentInactive(): void {
    this.clearReconnectTimer();
    this.closeSocket();
  }

  private reconnectEvents(): void {
    this.clearReconnectTimer();
    this.closeSocket();
    this.connectEvents();
  }

  private connectEvents(): void {
    if (!this.settings.deviceToken || this.unloading) return;
    if (document.visibilityState === "hidden") return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;

    const url = this.settings.serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + `/api/v1/events?token=${encodeURIComponent(this.settings.deviceToken)}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.checkPairingRequests();
      if (this.settings.autoSync) this.debouncedSync();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const message = parseServerEvent(event.data);
      if (message.type === "request_created") {
        this.checkPairingRequests();
      }
      if (message.type === "vault_changed" || message.type === "conflict_created") {
        this.syncEngine.syncNow().catch((error) => new Notice(`Private Sync: ${error.message}`));
      }
      this.refreshView();
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.unloading && document.visibilityState !== "hidden") {
        this.scheduleReconnect();
      }
    };
    socket.onerror = () => {
      if (this.socket === socket) socket.close();
    };
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null;
      this.connectEvents();
    }, 5000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimeout !== null) {
      window.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
    this.socket = null;
  }

  private maybeOpenPairingApproval(request: ServerRequest): void {
    if (request.type !== "device_pairing" || request.status !== "pending") return;
    if (this.activePairingRequestModals.has(request.id)) return;
    const payload = parseDevicePairingPayload(request);
    if (!payload) return;
    this.activePairingRequestModals.add(request.id);
    new PairingApprovalModal(this, request, payload, () => {
      this.activePairingRequestModals.delete(request.id);
    }).open();
  }
}

function debounce<T extends (...args: never[]) => void | Promise<void>>(fn: T, delay: number): T {
  let timeout: number | undefined;
  return ((...args: never[]) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => void fn(...args), delay);
  }) as T;
}

function parseServerEvent(data: unknown): { type?: string } {
  try {
    return JSON.parse(String(data)) as { type?: string };
  } catch {
    return {};
  }
}
