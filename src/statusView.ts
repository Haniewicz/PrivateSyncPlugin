import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { readLocalBinary } from "./localFiles";
import { parseDevicePairingPayload } from "./pairingApprovalModal";
import { ConflictDiffModal, decodeText, TextPreviewModal } from "./textPreviewModal";
import type PrivateSyncPlugin from "./plugin";
import type {
  DevicePairingRequestPayload,
  FileHistoryEntry,
  LocalFileRecord,
  RemoteDevice,
  ServerConflict,
  ServerRequest,
  SyncEvent
} from "./types";

export const PRIVATE_SYNC_VIEW = "private-sync-view";

type Tab = "status" | "devices" | "requests" | "conflicts" | "history" | "events";

type ConflictListItem = {
  key: string;
  path: string;
  local?: LocalFileRecord;
  remote?: ServerConflict;
};

export class PrivateSyncView extends ItemView {
  private activeTab: Tab = "status";
  private historyPath = "";
  private selectedConflictKeys = new Set<string>();
  private ignoredExpanded = false;

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
    this.actionButton(toolbar, "Sync now", "primary").onclick = () => {
      this.plugin.syncEngine.syncNow().catch((error) => {
        this.plugin.recordErrorEvent("Manual sync failed", error).catch(() => undefined);
        new Notice(`Private Sync: ${errorMessage(error)}`, 10000);
      });
    };
    this.actionButton(toolbar, "Pair", "primary").onclick = () => this.plugin.syncEngine.pairDevice();

    const tabs = root.createDiv({ cls: "private-sync-tabs" });
    for (const tab of ["status", "devices", "requests", "conflicts", "history", "events"] as Tab[]) {
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
    if (this.activeTab === "events") this.renderEvents(root);
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
    this.row(list, "Server vault", this.plugin.settings.vaultLinked ? this.plugin.settings.vaultId : `${this.plugin.settings.vaultId} (not linked)`);
    for (const status of ["synced", "pending_upload", "conflict", "locked_by_request", "ignored", "failed"] as const) {
      const matchingFiles = files.filter((file) => file.status === status);
      if (status === "ignored") {
        this.ignoredStatusRow(list, matchingFiles);
      } else {
        this.row(list, status, String(matchingFiles.length));
      }
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
    const conflictRoot = root.createDiv({ cls: "private-sync-conflict-panel" });
    const localConflicts = Object.values(this.plugin.indexStore.get().files).filter(
      (file) => file.status === "conflict" || file.status === "locked_by_request"
    );
    conflictRoot.createDiv({ text: "Loading conflicts", cls: "private-sync-muted" });
    this.plugin.api
      .conflicts(this.plugin.settings.vaultId)
      .then((response) => {
        this.renderConflictItems(conflictRoot, localConflicts, response.conflicts);
      })
      .catch((error) => {
        conflictRoot.empty();
        const items = localConflicts.map((conflict) => localConflictItem(conflict));
        this.pruneSelectedConflicts(items);
        this.conflictBulkToolbar(conflictRoot, items);
        const list = conflictRoot.createDiv({ cls: "private-sync-list" });
        if (items.length === 0) {
          this.row(list, "Error", error.message);
          return;
        }
        for (const item of items) this.conflictRow(list, item);
      });
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
    this.actionButton(controls, "Active file", "subtle").onclick = () => {
      if (!activeFile) {
        new Notice("Private Sync: no active file.", 5000);
        return;
      }
      this.historyPath = activeFile.path;
      this.render();
    };
    this.actionButton(controls, "Load", "primary").onclick = () => {
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

  private renderEvents(root: Element): void {
    const controls = root.createDiv({ cls: "private-sync-toolbar" });
    const errorCount = this.plugin.events.filter((event) => event.type === "error").length;
    controls.createDiv({
      text: `${this.plugin.events.length} events · ${errorCount} errors`,
      cls: "private-sync-muted private-sync-event-count"
    });
    const clearErrors = this.actionButton(controls, "Clear errors", "danger");
    clearErrors.disabled = errorCount === 0;
    clearErrors.onclick = () => {
      this.plugin.clearSyncEvents((event) => event.type === "error").catch((error) => {
        new Notice(`Private Sync: cannot clear error logs: ${errorMessage(error)}`, 10000);
      });
    };
    const clearAll = this.actionButton(controls, "Clear all", "danger");
    clearAll.disabled = this.plugin.events.length === 0;
    clearAll.onclick = () => {
      this.plugin.clearSyncEvents().catch((error) => {
        new Notice(`Private Sync: cannot clear event logs: ${errorMessage(error)}`, 10000);
      });
    };

    const list = root.createDiv({ cls: "private-sync-list" });
    if (this.plugin.events.length === 0) {
      this.row(list, "Events", "no sync events");
      return;
    }
    for (const event of this.plugin.events.slice(0, 100)) {
      const row = list.createDiv({ cls: "private-sync-row private-sync-event-row" });
      const details = row.createDiv();
      details.createDiv({ text: event.path ? `${event.type}: ${event.path}` : event.type });
      details.createDiv({ text: event.message, cls: "private-sync-muted" });
      const actions = row.createDiv({ cls: "private-sync-actions" });
      actions.createDiv({ text: event.timestamp, cls: "private-sync-muted private-sync-event-time" });
      this.actionButton(actions, "Details", "subtle").onclick = () => this.showEventDetails(event);
    }
  }

  private row(parent: Element, name: string, value: string): void {
    const row = parent.createDiv({ cls: "private-sync-row" });
    row.createDiv({ text: name, cls: "private-sync-row-name" });
    row.createDiv({ text: value, cls: "private-sync-muted private-sync-row-value" });
  }

  private ignoredStatusRow(parent: Element, files: LocalFileRecord[]): void {
    const row = parent.createDiv({ cls: "private-sync-row private-sync-action-row" });
    const details = row.createDiv();
    details.createDiv({ text: "ignored", cls: "private-sync-row-name" });
    details.createDiv({
      text: "Skipped by current sync settings, for example large files, disabled attachments, settings, or community plugins.",
      cls: "private-sync-muted private-sync-row-value"
    });
    const actions = row.createDiv({ cls: "private-sync-actions" });
    actions.createDiv({ text: String(files.length), cls: "private-sync-muted private-sync-status-count" });
    const toggle = this.actionButton(actions, this.ignoredExpanded ? "Hide" : "Show", "subtle");
    toggle.disabled = files.length === 0;
    toggle.onclick = () => {
      this.ignoredExpanded = !this.ignoredExpanded;
      this.render();
    };
    if (!this.ignoredExpanded || files.length === 0) return;
    const ignoredList = parent.createDiv({ cls: "private-sync-ignored-list" });
    for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
      const item = ignoredList.createDiv({ cls: "private-sync-ignored-item" });
      item.createDiv({ text: file.path });
      item.createDiv({ text: `${file.size} B`, cls: "private-sync-muted" });
    }
  }

  private renderConflictItems(root: Element, localConflicts: LocalFileRecord[], remoteConflicts: ServerConflict[]): void {
    root.empty();
    const items = buildConflictItems(localConflicts, remoteConflicts);
    this.pruneSelectedConflicts(items);
    this.conflictBulkToolbar(root, items);
    const list = root.createDiv({ cls: "private-sync-list" });
    if (items.length === 0) {
      this.row(list, "Status", "no conflicts");
      return;
    }
    for (const item of items) this.conflictRow(list, item);
  }

  private pruneSelectedConflicts(items: ConflictListItem[]): void {
    const visibleKeys = new Set(items.map((item) => item.key));
    for (const key of [...this.selectedConflictKeys]) {
      if (!visibleKeys.has(key)) this.selectedConflictKeys.delete(key);
    }
  }

  private conflictBulkToolbar(root: Element, conflicts: ConflictListItem[]): void {
    const toolbar = root.createDiv({ cls: "private-sync-toolbar private-sync-bulk-toolbar" });
    toolbar.createDiv({ text: `${this.selectedConflictKeys.size}/${conflicts.length} selected`, cls: "private-sync-muted private-sync-bulk-count" });
    const selectAll = this.actionButton(toolbar, "Select all", "subtle");
    selectAll.disabled = conflicts.length === 0;
    selectAll.onclick = () => {
      this.selectedConflictKeys = new Set(conflicts.map((conflict) => conflict.key));
      this.render();
    };
    const clear = this.actionButton(toolbar, "Clear", "subtle");
    clear.disabled = this.selectedConflictKeys.size === 0;
    clear.onclick = () => {
      this.selectedConflictKeys.clear();
      this.render();
    };
    const keepLocal = this.actionButton(toolbar, "Keep local", "success");
    keepLocal.disabled = this.selectedConflictKeys.size === 0;
    keepLocal.onclick = () => this.resolveSelectedConflicts(conflicts, "keep_local");
    const useServer = this.actionButton(toolbar, "Use server", "info");
    useServer.disabled = this.selectedConflictKeys.size === 0;
    useServer.onclick = () => this.resolveSelectedConflicts(conflicts, "use_server");
  }

  private requestRow(parent: Element, request: ServerRequest, payload: DevicePairingRequestPayload): void {
    const row = parent.createDiv({ cls: "private-sync-row private-sync-request-row" });
    const details = row.createDiv();
    details.createDiv({ text: payload.deviceName });
    details.createDiv({ text: `${payload.deviceType}${payload.ip ? ` · ${payload.ip}` : ""}`, cls: "private-sync-muted" });
    const approve = this.actionButton(row, "Approve", "success");
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
    const toggle = this.actionButton(row, device.revoked_at ? "Restore" : "Revoke", device.revoked_at ? "success" : "danger");
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
    const remove = this.actionButton(row, "Delete", "danger");
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

  private conflictRow(parent: Element, conflict: ConflictListItem): void {
    const row = parent.createDiv({ cls: "private-sync-row private-sync-conflict-row" });
    const checkbox = row.createEl("input", { type: "checkbox", cls: "private-sync-conflict-checkbox" });
    checkbox.checked = this.selectedConflictKeys.has(conflict.key);
    checkbox.onchange = () => {
      if (checkbox.checked) {
        this.selectedConflictKeys.add(conflict.key);
      } else {
        this.selectedConflictKeys.delete(conflict.key);
      }
      this.render();
    };
    const details = row.createDiv();
    details.createDiv({ text: conflict.path });
    details.createDiv({ text: conflictSummary(conflict), cls: "private-sync-muted" });
    const actions = row.createDiv({ cls: "private-sync-actions" });
    this.actionButton(actions, "Diff / fragments", "subtle").onclick = () => this.showConflictDiff(conflict);
    const keepLocal = this.actionButton(actions, "Keep local", "success");
    keepLocal.disabled = !conflict.local;
    keepLocal.onclick = () => this.resolveConflict(conflict, "keep_local");
    this.actionButton(actions, "Use server", "info").onclick = () => this.resolveConflict(conflict, "use_server");
  }

  private async resolveConflict(conflict: ConflictListItem, strategy: "keep_local" | "use_server"): Promise<void> {
    try {
      await this.plugin.syncEngine.resolveLocalConflict(conflict.path, strategy, conflict.remote?.id);
      this.selectedConflictKeys.delete(conflict.key);
      this.render();
    } catch (error) {
      new Notice(`Private Sync conflict resolution failed: ${errorMessage(error)}`, 10000);
    }
  }

  private async resolveSelectedConflicts(conflicts: ConflictListItem[], strategy: "keep_local" | "use_server"): Promise<void> {
    const selected = conflicts.filter((conflict) => this.selectedConflictKeys.has(conflict.key));
    if (selected.length === 0) return;
    let succeeded = 0;
    const failed: string[] = [];
    for (const conflict of selected) {
      if (strategy === "keep_local" && !conflict.local) {
        failed.push(`${conflict.path}: local version is unavailable`);
        continue;
      }
      try {
        await this.plugin.syncEngine.resolveLocalConflict(conflict.path, strategy, conflict.remote?.id);
        this.selectedConflictKeys.delete(conflict.key);
        succeeded += 1;
      } catch (error) {
        failed.push(`${conflict.path}: ${errorMessage(error)}`);
      }
    }
    if (failed.length > 0) {
      new Notice(`Private Sync: resolved ${succeeded}/${selected.length} conflicts. Failed: ${failed.slice(0, 3).join("; ")}`, 15000);
    } else {
      new Notice(`Private Sync: resolved ${succeeded} conflicts.`, 8000);
    }
    this.render();
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
    const preview = this.actionButton(actions, "Preview", "subtle");
    preview.disabled = Boolean(entry.deleted);
    preview.onclick = () => this.previewRevision(entry);
    this.actionButton(actions, "Restore", "success").onclick = () => this.restoreRevision(entry);
  }

  private decisionRequestRow(parent: Element, request: ServerRequest): void {
    const row = parent.createDiv({ cls: "private-sync-row private-sync-action-row" });
    const details = row.createDiv();
    details.createDiv({ text: requestLabel(request.type) });
    details.createDiv({ text: requestPayloadSummary(request), cls: "private-sync-muted" });
    const actions = row.createDiv({ cls: "private-sync-actions" });
    this.actionButton(actions, "Details", "subtle").onclick = () => {
      new TextPreviewModal(this.plugin, requestLabel(request.type), requestPayloadPretty(request)).open();
    };
    this.actionButton(actions, "Approve", "success").onclick = () => this.resolveRequest(request, "approved");
    this.actionButton(actions, "Reject", "danger").onclick = () => this.resolveRequest(request, "rejected");
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

  private async showConflictDiff(conflict: ConflictListItem): Promise<void> {
    try {
      const path = conflict.path;
      const local = decodeText(await readLocalBinary(this.plugin, path).catch(() => new ArrayBuffer(0)));
      const server = decodeText(await this.plugin.api.download(this.plugin.settings.vaultId, path));
      new ConflictDiffModal(this.plugin, `Diff: ${path}`, local, server, async (mergedText) => {
        await this.plugin.syncEngine.resolveLocalConflictWithText(path, mergedText, conflict.remote?.id);
        this.selectedConflictKeys.delete(conflict.key);
        this.render();
      }).open();
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

  private showEventDetails(event: SyncEvent): void {
    new TextPreviewModal(this.plugin, `Event: ${event.type}`, eventDetailsPretty(event)).open();
  }

  private actionButton(parent: Element, text: string, tone: "primary" | "success" | "info" | "danger" | "subtle"): HTMLButtonElement {
    return parent.createEl("button", { text, cls: `private-sync-button private-sync-button-${tone}` });
  }
}

function label(tab: Tab): string {
  return tab.slice(0, 1).toUpperCase() + tab.slice(1);
}

function buildConflictItems(localConflicts: LocalFileRecord[], remoteConflicts: ServerConflict[]): ConflictListItem[] {
  const localByPath = new Map(localConflicts.map((conflict) => [conflict.path, conflict]));
  const remotePaths = new Set(remoteConflicts.map((conflict) => conflict.filePath));
  const items: ConflictListItem[] = remoteConflicts.map((conflict) => ({
    key: `remote:${conflict.id}`,
    path: conflict.filePath,
    local: localByPath.get(conflict.filePath),
    remote: conflict
  }));
  for (const conflict of localConflicts) {
    if (remotePaths.has(conflict.path)) continue;
    items.push(localConflictItem(conflict));
  }
  return items;
}

function localConflictItem(conflict: LocalFileRecord): ConflictListItem {
  return {
    key: `local:${conflict.path}`,
    path: conflict.path,
    local: conflict
  };
}

function conflictSummary(conflict: ConflictListItem): string {
  if (!conflict.remote) return conflict.local?.status ?? "local conflict";
  const owner = conflict.remote.deviceName ?? conflict.remote.deviceId;
  const created = new Date(conflict.remote.createdAt);
  const createdText = Number.isNaN(created.getTime()) ? conflict.remote.createdAt : created.toLocaleString();
  return `pending conflict ${conflict.remote.id} from ${owner} · ${createdText}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function eventDetailsPretty(event: SyncEvent): string {
  return JSON.stringify(
    {
      timestamp: event.timestamp,
      type: event.type,
      path: event.path,
      message: event.message,
      details: event.details ?? null
    },
    null,
    2
  );
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
