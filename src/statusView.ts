import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { parseDevicePairingPayload } from "./pairingApprovalModal";
import type PrivateSyncPlugin from "./plugin";
import type { DevicePairingRequestPayload, FileHistoryEntry, LocalFileRecord, RemoteDevice, ServerConflict, ServerRequest } from "./types";

export const PRIVATE_SYNC_VIEW = "private-sync-view";

type Tab = "status" | "devices" | "requests" | "conflicts" | "history";

export class PrivateSyncView extends ItemView {
  private activeTab: Tab = "status";
  private historyPath = "";

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
        if (response.devices.length === 0) {
          this.row(list, "Status", "no devices");
          return;
        }
        for (const device of response.devices) this.deviceRow(list, device);
      })
      .catch((error) => this.row(list, "Error", error.message));
    this.row(list, "Loading", kind);
  }

  private renderConflicts(root: Element): void {
    const list = root.createDiv({ cls: "private-sync-list" });
    const localConflicts = Object.values(this.plugin.indexStore.get().files).filter(
      (file) => file.status === "conflict" || file.status === "locked_by_request"
    );
    for (const conflict of localConflicts) this.localConflictRow(list, conflict);
    this.plugin.api
      .conflicts(this.plugin.settings.vaultId)
      .then((response) => {
        const remoteOnly = response.conflicts.filter((conflict) => !localConflicts.some((local) => local.path === conflict.filePath));
        if (localConflicts.length === 0 && remoteOnly.length === 0) {
          list.empty();
          this.row(list, "Status", "no conflicts");
          return;
        }
        for (const conflict of remoteOnly) this.remoteConflictRow(list, conflict);
      })
      .catch((error) => {
        if (localConflicts.length === 0) this.row(list, "Error", error.message);
      });
    if (localConflicts.length === 0) this.row(list, "Loading", "conflicts");
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
    const controls = root.createDiv({ cls: "private-sync-toolbar" });
    const input = controls.createEl("input", {
      type: "text",
      placeholder: "Path, e.g. Notes/today.md",
      value: this.historyPath
    });
    input.onchange = () => {
      this.historyPath = input.value.trim();
      this.render();
    };
    const activeFile = this.plugin.app.workspace.getActiveFile();
    controls.createEl("button", { text: "Active file" }).onclick = () => {
      if (!activeFile) {
        new Notice("Private Sync: no active file.", 5000);
        return;
      }
      this.historyPath = activeFile.path;
      this.render();
    };
    controls.createEl("button", { text: "Load" }).onclick = () => {
      this.historyPath = input.value.trim();
      this.render();
    };

    const list = root.createDiv({ cls: "private-sync-list" });
    if (!this.historyPath) {
      this.row(list, "History", "choose a file path");
      return;
    }
    this.plugin.api
      .history(this.plugin.settings.vaultId, this.historyPath)
      .then((response) => {
        list.empty();
        if (response.history.length === 0) {
          this.row(list, "History", "no revisions");
          return;
        }
        for (const entry of response.history) this.historyRow(list, entry);
      })
      .catch((error) => this.row(list, "Error", error.message));
    this.row(list, "Loading", this.historyPath);
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

  private deviceRow(parent: Element, device: RemoteDevice): void {
    const row = parent.createDiv({ cls: "private-sync-row private-sync-action-row" });
    const details = row.createDiv();
    details.createDiv({ text: device.name });
    details.createDiv({
      text: `${device.type} · ${device.revoked_at ? "revoked" : "trusted"} · last seen ${device.last_seen_at ?? "never"}`,
      cls: "private-sync-muted"
    });
    const revoke = row.createEl("button", { text: "Revoke" });
    revoke.disabled = Boolean(device.revoked_at) || device.id === this.plugin.settings.deviceId;
    revoke.onclick = async () => {
      revoke.disabled = true;
      revoke.textContent = "Revoking...";
      try {
        await this.plugin.api.revokeDevice(device.id);
        new Notice(`Private Sync: revoked ${device.name}.`, 8000);
        this.render();
      } catch (error) {
        new Notice(`Private Sync revoke failed: ${errorMessage(error)}`, 10000);
        revoke.disabled = false;
        revoke.textContent = "Revoke";
      }
    };
  }

  private localConflictRow(parent: Element, conflict: LocalFileRecord): void {
    const row = parent.createDiv({ cls: "private-sync-row private-sync-conflict-row" });
    const details = row.createDiv();
    details.createDiv({ text: conflict.path });
    details.createDiv({ text: conflict.status, cls: "private-sync-muted" });
    const actions = row.createDiv({ cls: "private-sync-actions" });
    actions.createEl("button", { text: "Keep local" }).onclick = () => this.resolveConflict(conflict.path, "keep_local");
    actions.createEl("button", { text: "Use server" }).onclick = () => this.resolveConflict(conflict.path, "use_server");
  }

  private remoteConflictRow(parent: Element, conflict: ServerConflict): void {
    const row = parent.createDiv({ cls: "private-sync-row" });
    row.createDiv({ text: conflict.filePath });
    row.createDiv({
      text: `pending on ${conflict.deviceName ?? conflict.deviceId}`,
      cls: "private-sync-muted"
    });
  }

  private async resolveConflict(path: string, strategy: "keep_local" | "use_server"): Promise<void> {
    try {
      await this.plugin.syncEngine.resolveLocalConflict(path, strategy);
      this.render();
    } catch (error) {
      new Notice(`Private Sync conflict resolution failed: ${errorMessage(error)}`, 10000);
    }
  }

  private historyRow(parent: Element, entry: FileHistoryEntry): void {
    const row = parent.createDiv({ cls: "private-sync-row" });
    row.createDiv({ text: `Revision ${entry.vaultRevision}` });
    row.createDiv({
      text: `${entry.deleted ? "deleted" : `${entry.size} B`} · ${entry.createdAt}`,
      cls: "private-sync-muted"
    });
  }
}

function label(tab: Tab): string {
  return tab.slice(0, 1).toUpperCase() + tab.slice(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
