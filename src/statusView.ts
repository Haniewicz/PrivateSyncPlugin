import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { parseDevicePairingPayload } from "./pairingApprovalModal";
import { buildLineDiff, decodeText, TextPreviewModal } from "./textPreviewModal";
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
        const pendingRequests = response.requests.filter((request) => request.status === "pending");
        if (pendingRequests.length === 0) {
          this.row(list, "Status", "no pending requests");
          return;
        }
        for (const request of pendingRequests) {
          if (request.type === "device_pairing") {
            const payload = parseDevicePairingPayload(request);
            if (payload) {
              this.requestRow(list, request, payload);
            } else {
              this.row(list, request.id, "invalid pairing payload");
            }
          } else {
            this.decisionRequestRow(list, request);
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
    const toggle = row.createEl("button", { text: device.revoked_at ? "Restore" : "Revoke" });
    toggle.disabled = device.id === this.plugin.settings.deviceId;
    toggle.onclick = async () => {
      toggle.disabled = true;
      toggle.textContent = device.revoked_at ? "Restoring..." : "Revoking...";
      try {
        if (device.revoked_at) {
          await this.plugin.api.restoreDevice(device.id);
          new Notice(`Private Sync: restored ${device.name}.`, 8000);
        } else {
          await this.plugin.api.revokeDevice(device.id);
          new Notice(`Private Sync: revoked ${device.name}.`, 8000);
        }
        this.render();
      } catch (error) {
        new Notice(`Private Sync device update failed: ${errorMessage(error)}`, 10000);
        toggle.disabled = false;
        toggle.textContent = device.revoked_at ? "Restore" : "Revoke";
      }
    };
    const remove = row.createEl("button", { text: "Delete" });
    remove.disabled = device.id === this.plugin.settings.deviceId;
    remove.onclick = async () => {
      remove.disabled = true;
      remove.textContent = "Deleting...";
      try {
        await this.plugin.api.deleteDevice(device.id);
        new Notice(`Private Sync: deleted ${device.name}.`, 8000);
        this.render();
      } catch (error) {
        new Notice(`Private Sync device delete failed: ${errorMessage(error)}`, 10000);
        remove.disabled = false;
        remove.textContent = "Delete";
      }
    };
  }

  private localConflictRow(parent: Element, conflict: LocalFileRecord): void {
    const row = parent.createDiv({ cls: "private-sync-row private-sync-conflict-row" });
    const details = row.createDiv();
    details.createDiv({ text: conflict.path });
    details.createDiv({ text: conflict.status, cls: "private-sync-muted" });
    const actions = row.createDiv({ cls: "private-sync-actions" });
    actions.createEl("button", { text: "Diff" }).onclick = () => this.showConflictDiff(conflict.path);
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
    const row = parent.createDiv({ cls: "private-sync-row private-sync-action-row" });
    const details = row.createDiv();
    details.createDiv({ text: `Revision ${entry.vaultRevision}` });
    details.createDiv({
      text: `${entry.deleted ? "deleted" : `${entry.size} B`} · ${entry.createdAt}`,
      cls: "private-sync-muted"
    });
    const actions = row.createDiv({ cls: "private-sync-actions" });
    const preview = actions.createEl("button", { text: "Preview" });
    preview.disabled = Boolean(entry.deleted);
    preview.onclick = () => this.previewRevision(entry);
    actions.createEl("button", { text: "Restore" }).onclick = () => this.restoreRevision(entry);
  }

  private decisionRequestRow(parent: Element, request: ServerRequest): void {
    const row = parent.createDiv({ cls: "private-sync-row private-sync-action-row" });
    const details = row.createDiv();
    details.createDiv({ text: requestLabel(request.type) });
    details.createDiv({ text: requestPayloadSummary(request), cls: "private-sync-muted" });
    const actions = row.createDiv({ cls: "private-sync-actions" });
    actions.createEl("button", { text: "Details" }).onclick = () => {
      new TextPreviewModal(this.plugin, requestLabel(request.type), requestPayloadPretty(request)).open();
    };
    actions.createEl("button", { text: "Approve" }).onclick = () => this.resolveRequest(request, "approved");
    actions.createEl("button", { text: "Reject" }).onclick = () => this.resolveRequest(request, "rejected");
  }

  private async resolveRequest(request: ServerRequest, status: "approved" | "rejected"): Promise<void> {
    try {
      await this.plugin.api.resolveRequest(this.plugin.settings.vaultId, request.id, status, { decidedIn: "plugin" });
      new Notice(`Private Sync: request ${status}.`, 8000);
      await this.plugin.syncEngine.syncNow();
      this.render();
    } catch (error) {
      new Notice(`Private Sync request update failed: ${errorMessage(error)}`, 10000);
    }
  }

  private async showConflictDiff(path: string): Promise<void> {
    try {
      const localFile = this.plugin.app.vault.getAbstractFileByPath(path);
      const local = localFile instanceof TFile ? decodeText(await this.plugin.app.vault.readBinary(localFile)) : "";
      const server = decodeText(await this.plugin.api.download(this.plugin.settings.vaultId, path));
      new TextPreviewModal(this.plugin, `Diff: ${path}`, buildLineDiff("Local", local, "Server", server)).open();
    } catch (error) {
      new Notice(`Private Sync diff failed: ${errorMessage(error)}`, 10000);
    }
  }

  private async previewRevision(entry: FileHistoryEntry): Promise<void> {
    try {
      const content = decodeText(await this.plugin.api.downloadRevision(this.plugin.settings.vaultId, entry.id));
      new TextPreviewModal(this.plugin, `Revision ${entry.vaultRevision}: ${this.historyPath}`, content).open();
    } catch (error) {
      new Notice(`Private Sync preview failed: ${errorMessage(error)}`, 10000);
    }
  }

  private async restoreRevision(entry: FileHistoryEntry): Promise<void> {
    try {
      await this.plugin.api.restoreRevision(this.plugin.settings.vaultId, entry.id);
      new Notice(`Private Sync: restored revision ${entry.vaultRevision}.`, 8000);
      await this.plugin.syncEngine.syncNow();
      this.render();
    } catch (error) {
      new Notice(`Private Sync restore failed: ${errorMessage(error)}`, 10000);
    }
  }
}

function label(tab: Tab): string {
  return tab.slice(0, 1).toUpperCase() + tab.slice(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestLabel(type: string): string {
  if (type === "mass_delete_approval") return "Mass delete approval";
  if (type === "suspicious_operation") return "Suspicious operation";
  if (type === "conflict_resolution") return "Conflict resolution";
  if (type === "restore_version") return "Restore version";
  return type;
}

function requestPayloadSummary(request: ServerRequest): string {
  const payload = parseRequestPayload(request);
  if (!payload) return request.createdAt ?? request.created_at ?? "pending";
  const parts = [];
  if (typeof payload.operationCount === "number") parts.push(`${payload.operationCount} operations`);
  if (typeof payload.deleteCount === "number") parts.push(`${payload.deleteCount} deletes`);
  if (typeof payload.emptyWrites === "number") parts.push(`${payload.emptyWrites} empty writes`);
  if (typeof payload.batchId === "string") parts.push(`batch ${payload.batchId}`);
  return parts.join(" · ") || request.createdAt || request.created_at || "pending";
}

function requestPayloadPretty(request: ServerRequest): string {
  const payload = parseRequestPayload(request);
  return JSON.stringify(
    {
      id: request.id,
      type: request.type,
      createdAt: request.createdAt ?? request.created_at,
      createdByDeviceId: request.createdByDeviceId ?? request.created_by_device_id,
      payload
    },
    null,
    2
  );
}

function parseRequestPayload(request: ServerRequest): Record<string, unknown> | null {
  const raw = request.payloadJson ?? request.payload_json;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
