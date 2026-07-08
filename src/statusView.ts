import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { parseDevicePairingPayload } from "./pairingApprovalModal";
import type PrivateSyncPlugin from "./plugin";
import type { DevicePairingRequestPayload, ServerRequest } from "./types";

export const PRIVATE_SYNC_VIEW = "private-sync-view";

type Tab = "status" | "devices" | "requests" | "conflicts" | "history";

export class PrivateSyncView extends ItemView {
  private activeTab: Tab = "status";

  constructor(leaf: WorkspaceLeaf, private readonly plugin: PrivateSyncPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return PRIVATE_SYNC_VIEW;
  }

  getDisplayText(): string {
    return "Private Sync";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  refresh(): void {
    this.render();
  }

  private render(): void {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("private-sync-view");

    const toolbar = root.createDiv({ cls: "private-sync-toolbar" });
    toolbar.createEl("button", { text: "Sync now" }).onclick = () => this.plugin.syncEngine.syncNow();
    toolbar.createEl("button", { text: "Pair" }).onclick = () => this.plugin.syncEngine.pairDevice();

    const tabs = root.createDiv({ cls: "private-sync-tabs" });
    for (const tab of ["status", "devices", "requests", "conflicts", "history"] as Tab[]) {
      const button = tabs.createEl("button", { text: label(tab), cls: "private-sync-tab" });
      if (tab === this.activeTab) button.addClass("is-active");
      button.onclick = () => {
        this.activeTab = tab;
        this.render();
      };
    }

    if (this.activeTab === "status") this.renderStatus(root);
    if (this.activeTab === "devices") this.renderRemoteList(root, "devices");
    if (this.activeTab === "requests") this.renderRequests(root);
    if (this.activeTab === "conflicts") this.renderConflicts(root);
    if (this.activeTab === "history") this.renderHistory(root);
  }

  private renderStatus(root: Element): void {
    const index = this.plugin.indexStore.get();
    const files = Object.values(index.files);
    const list = root.createDiv({ cls: "private-sync-list" });
    this.row(list, "Server", this.plugin.settings.serverUrl);
    this.row(list, "Device", this.plugin.settings.deviceId ? this.plugin.settings.deviceName : "not paired");
    this.row(list, "Last applied revision", String(index.lastAppliedRevision));
    this.row(list, "Indexed files", String(files.length));
    this.row(list, "Pending operations", String(index.queue.length));
    for (const status of ["synced", "pending_upload", "conflict", "locked_by_request", "ignored", "failed"]) {
      this.row(list, status, String(files.filter((file) => file.status === status).length));
    }
  }

  private renderRemoteList(root: Element, kind: "devices"): void {
    const list = root.createDiv({ cls: "private-sync-list" });
    this.plugin.api
      .devices()
      .then((response) => {
        list.empty();
        for (const device of response.devices) this.row(list, "Device", JSON.stringify(device));
      })
      .catch((error) => this.row(list, "Error", error.message));
    this.row(list, "Loading", kind);
  }

  private renderConflicts(root: Element): void {
    const list = root.createDiv({ cls: "private-sync-list" });
    const conflicts = Object.values(this.plugin.indexStore.get().files).filter((file) => file.status === "conflict" || file.status === "locked_by_request");
    if (conflicts.length === 0) {
      this.row(list, "Status", "no local conflicts");
      return;
    }
    for (const conflict of conflicts) this.row(list, conflict.path, conflict.status);
  }

  private renderRequests(root: Element): void {
    const list = root.createDiv({ cls: "private-sync-list" });
    if (!this.plugin.settings.deviceToken) {
      this.row(list, "Status", "not paired");
      return;
    }
    this.plugin.api
      .requests(this.plugin.settings.vaultId)
      .then((response) => {
        list.empty();
        const pairingRequests = response.requests.filter((request) => request.type === "device_pairing" && request.status === "pending");
        if (pairingRequests.length === 0) {
          this.row(list, "Status", "no pending requests");
          return;
        }
        for (const request of pairingRequests) {
          const payload = parseDevicePairingPayload(request);
          if (payload) {
            this.requestRow(list, request, payload);
          } else {
            this.row(list, request.id, "invalid pairing payload");
          }
        }
      })
      .catch((error) => this.row(list, "Error", error.message));
    this.row(list, "Loading", "requests");
  }

  private renderHistory(root: Element): void {
    const list = root.createDiv({ cls: "private-sync-list" });
    this.row(list, "History", "select file history API is ready on the server; file picker UI is next");
  }

  private row(parent: Element, name: string, value: string): void {
    const row = parent.createDiv({ cls: "private-sync-row" });
    row.createDiv({ text: name });
    row.createDiv({ text: value, cls: "private-sync-muted" });
  }

  private requestRow(parent: Element, request: ServerRequest, payload: DevicePairingRequestPayload): void {
    const row = parent.createDiv({ cls: "private-sync-row private-sync-request-row" });
    const details = row.createDiv();
    details.createDiv({ text: payload.deviceName });
    details.createDiv({ text: `${payload.deviceType}${payload.ip ? ` · ${payload.ip}` : ""}`, cls: "private-sync-muted" });
    const approve = row.createEl("button", { text: "Approve" });
    approve.onclick = async () => {
      approve.disabled = true;
      approve.textContent = "Approving...";
      try {
        await this.plugin.api.approveDeviceRequest({
          requestId: request.id,
          deviceName: payload.deviceName,
          deviceType: payload.deviceType
        });
        new Notice(`Private Sync: approved ${payload.deviceName}.`, 8000);
        this.render();
      } catch (error) {
        new Notice(`Private Sync approval failed: ${errorMessage(error)}`, 10000);
        approve.disabled = false;
        approve.textContent = "Approve";
      }
    };
  }
}

function label(tab: Tab): string {
  return tab.slice(0, 1).toUpperCase() + tab.slice(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
