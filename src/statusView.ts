import { ItemView, Modal, Notice, WorkspaceLeaf } from "obsidian";
import { verifyEncryptionKeyCheck } from "./crypto";
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
  ServerStorageUsage,
  ServerVault,
  StorageCleanupTarget,
  SyncEvent
} from "./types";

export const PRIVATE_SYNC_VIEW = "private-sync-view";

type Tab = "status" | "devices" | "vaults" | "requests" | "conflicts" | "history" | "events" | "storage";

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
    for (const tab of ["status", "devices", "vaults", "requests", "conflicts", "history", "events", "storage"] as Tab[]) {
      const button = tabs.createEl("button", { text: label(tab), cls: "private-sync-tab" });
      if (tab === this.activeTab) button.addClass("is-active");
      button.onclick = () => {
        this.activeTab = tab;
        this.render();
      };
    }

    if (this.activeTab === "status") this.renderStatus(root);
    if (this.activeTab === "devices") this.renderRemoteList(root, "devices");
    if (this.activeTab === "vaults") this.renderVaults(root);
    if (this.activeTab === "requests") this.renderRequests(root);
    if (this.activeTab === "conflicts") this.renderConflicts(root);
    if (this.activeTab === "history") this.renderHistory(root);
    if (this.activeTab === "events") this.renderEvents(root);
    if (this.activeTab === "storage") this.renderStorage(root);
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
    this.row(
      list,
      "Encryption",
      this.plugin.settings.encryptionEnabled
        ? this.plugin.isEncryptionUnlocked()
          ? "enabled and unlocked"
          : "enabled and locked"
        : this.plugin.settings.encryptionKeyCheck
          ? "configured but disabled"
          : "disabled"
    );
    const vault = formatVaultLabel(this.plugin.settings.vaultName, this.plugin.settings.vaultId);
    this.row(list, "Server vault", this.plugin.settings.vaultLinked ? vault : `${vault} (not linked)`);
    for (const status of ["synced", "pending_upload", "pending_download", "conflict", "locked_by_request", "ignored", "failed"] as const) {
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

  private renderVaults(root: Element): void {
    const toolbar = root.createDiv({ cls: "private-sync-toolbar" });
    toolbar.createDiv({ text: "Server vaults", cls: "private-sync-muted private-sync-event-count" });
    this.actionButton(toolbar, "Refresh", "subtle").onclick = () => this.render();

    const list = root.createDiv({ cls: "private-sync-list" });
    if (!this.plugin.settings.deviceToken) {
      this.row(list, "Status", "not paired");
      return;
    }
    this.plugin.api
      .getVaults()
      .then((response) => {
        list.empty();
        const vaults = response.vaults.sort((left, right) => left.name.localeCompare(right.name));
        this.updateCurrentVaultName(vaults);
        if (vaults.length === 0) {
          this.row(list, "Status", "no vaults");
          return;
        }
        for (const vault of vaults) this.vaultRow(list, vault);
      })
      .catch((error) => {
        list.empty();
        this.row(list, "Error", errorMessage(error));
      });
    this.row(list, "Loading", "vaults");
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

  private renderStorage(root: Element): void {
    const toolbar = root.createDiv({ cls: "private-sync-toolbar" });
    toolbar.createDiv({ text: "Server storage", cls: "private-sync-muted private-sync-event-count" });
    this.actionButton(toolbar, "Refresh", "subtle").onclick = () => this.render();

    const list = root.createDiv({ cls: "private-sync-list private-sync-storage-list" });
    if (!this.plugin.settings.deviceToken) {
      this.row(list, "Status", "not paired");
      return;
    }
    this.plugin.api
      .storageUsage()
      .then((usage) => this.renderStorageUsage(list, usage))
      .catch((error) => {
        list.empty();
        this.row(list, "Error", errorMessage(error));
      });
    this.row(list, "Loading", "storage usage");
  }

  private renderStorageUsage(list: Element, usage: ServerStorageUsage): void {
    list.empty();
    this.row(list, "Total data", `${formatBytes(usage.totals.diskBytes)} on disk · ${formatBytes(usage.totals.bytes)} logical`);
    this.row(list, "Data directory", usage.totals.dataDir);
    this.row(list, "Blobs", formatSizeInfo(usage.totals.blobs));
    this.row(list, "Database", formatSizeInfo(usage.totals.database));
    this.row(
      list,
      "Staging",
      `${formatSizeInfo(usage.totals.staging)} · ${usage.totals.staging.directories} dirs · ${usage.totals.staging.files} files · ${usage.totals.staging.staleDirectories} stale`
    );
    this.row(list, "npm cache", usage.totals.npmCache.exists ? formatSizeInfo(usage.totals.npmCache) : "not present");

    const cleanupTargets = usage.cleanup.safeTargets.filter((target) => target.available);
    const cleanupRow = list.createDiv({ cls: "private-sync-row private-sync-action-row" });
    const cleanupDetails = cleanupRow.createDiv();
    cleanupDetails.createDiv({ text: "Safe cleanup" });
    cleanupDetails.createDiv({
      text: cleanupTargets.length === 0 ? "No removable safe data detected." : cleanupTargets.map((target) => `${target.label}: ${formatBytes(target.bytes)}`).join(" · "),
      cls: "private-sync-muted"
    });
    const cleanupActions = cleanupRow.createDiv({ cls: "private-sync-actions" });
    for (const target of usage.cleanup.safeTargets) {
      const button = this.actionButton(cleanupActions, `Clean ${target.label}`, "danger");
      button.disabled = !target.available;
      button.onclick = () => this.cleanupStorage([target.target], button);
    }
    const cleanAll = this.actionButton(cleanupActions, "Clean all safe", "danger");
    cleanAll.disabled = cleanupTargets.length === 0;
    cleanAll.onclick = () => this.cleanupStorage(cleanupTargets.map((target) => target.target), cleanAll);

    const vaultHeader = list.createDiv({ cls: "private-sync-storage-heading" });
    vaultHeader.createDiv({ text: "Vaults" });
    vaultHeader.createDiv({ text: `${usage.vaults.length} vaults`, cls: "private-sync-muted" });
    for (const vault of usage.vaults) {
      const row = list.createDiv({ cls: "private-sync-row private-sync-storage-vault-row" });
      const details = row.createDiv();
      details.createDiv({ text: vault.name });
      details.createDiv({ text: `${vault.id} · revision ${vault.currentRevision}`, cls: "private-sync-muted" });
      const values = row.createDiv({ cls: "private-sync-storage-values" });
      values.createDiv({ text: `Live: ${formatBytes(vault.liveBytes)} / ${vault.liveFiles} files` });
      values.createDiv({ text: `History: ${formatBytes(vault.historyBytes)} / ${vault.revisions} revisions`, cls: "private-sync-muted" });
      values.createDiv({ text: `Unique blobs: ${formatBytes(vault.uniqueBlobBytes)} · deleted rows: ${vault.deletedFiles}`, cls: "private-sync-muted" });
    }
  }

  private async cleanupStorage(targets: StorageCleanupTarget[], button: HTMLButtonElement): Promise<void> {
    if (targets.length === 0) return;
    const previousText = button.textContent ?? "Clean";
    button.disabled = true;
    button.textContent = "Cleaning...";
    try {
      const result = await this.plugin.api.cleanupStorage(targets);
      const removed = result.cleaned.reduce((sum, item) => sum + item.removedBytes, 0);
      new Notice(`Private Sync: cleaned ${formatBytes(removed)}.`, 8000);
      this.render();
    } catch (error) {
      new Notice(`Private Sync cleanup failed: ${errorMessage(error)}`, 10000);
      button.disabled = false;
      button.textContent = previousText;
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
    const vault = device.vaultId ? `${device.vaultName ?? "Unnamed vault"} (${device.vaultId})` : "no vault assigned";
    details.createDiv({
      text: `${device.type} · ${device.revoked_at ? "revoked" : "trusted"} · ${vault} · last seen ${device.last_seen_at ?? "never"}`,
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

  private vaultRow(parent: Element, vault: ServerVault): void {
    const row = parent.createDiv({ cls: "private-sync-row private-sync-action-row" });
    const details = row.createDiv();
    details.createDiv({ text: vault.name });
    const linked = this.plugin.settings.vaultLinked && vault.id === this.plugin.settings.vaultId;
    details.createDiv({
      text: `${vault.id} · revision ${vault.currentRevision}${linked ? " · linked to this local vault" : ""}`,
      cls: "private-sync-muted"
    });
    const actions = row.createDiv({ cls: "private-sync-actions" });
    this.actionButton(actions, "Rename", "subtle").onclick = () => this.renameVault(vault);
    const remove = this.actionButton(actions, "Delete", "danger");
    remove.disabled = linked;
    remove.title = linked ? "This vault is linked to the current local Obsidian vault and cannot be deleted here." : "";
    remove.onclick = () => {
      if (linked) {
        new Notice("Private Sync: cannot delete the server vault linked to this local vault.", 8000);
        return;
      }
      this.confirmDeleteVault(vault);
    };
  }

  private updateCurrentVaultName(vaults: ServerVault[]): void {
    const current = vaults.find((vault) => vault.id === this.plugin.settings.vaultId);
    if (!current || this.plugin.settings.vaultName === current.name) return;
    this.plugin.settings.vaultName = current.name;
    this.plugin.saveSettings().catch((error) => {
      new Notice(`Private Sync: cannot update local vault name: ${errorMessage(error)}`, 10000);
    });
  }

  private renameVault(vault: ServerVault): void {
    new VaultRenameModal(this.plugin, vault, async (name) => {
      await this.plugin.api.renameVault(vault.id, { name });
      if (vault.id === this.plugin.settings.vaultId) {
        this.plugin.settings.vaultName = name;
        await this.plugin.saveSettings();
      }
      new Notice(`Private Sync: renamed vault to ${name}.`, 8000);
      this.render();
    }).open();
  }

  private confirmDeleteVault(vault: ServerVault): void {
    new VaultDeleteModal(this.plugin, vault, async () => {
      await this.plugin.api.deleteVault(vault.id);
      new Notice(`Private Sync: deleted vault ${vault.name}.`, 8000);
      this.render();
    }).open();
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
      text: `${entry.deleted ? "deleted" : `${historyEntrySize(entry)} B${entry.encrypted ? " · encrypted" : ""}`} · ${entry.createdAt}`,
      cls: "private-sync-muted"
    });
    const actions = row.createDiv({ cls: "private-sync-actions" });
    const preview = this.actionButton(actions, "Preview", "subtle");
    preview.disabled = Boolean(entry.deleted);
    preview.onclick = () => this.previewRevision(entry);
    this.actionButton(actions, "Restore", "success").onclick = () => this.restoreRevision(entry);
    if (!entry.deleted && !entry.encrypted) {
      this.actionButton(actions, "Encrypt history", "subtle").onclick = () => this.encryptHistoryRevision(entry);
    }
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
      const server = decodeText(await this.plugin.syncEngine.downloadCurrentFilePlain(path));
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
      const content = decodeText(await this.downloadHistoryEntryForUi(entry));
      new TextPreviewModal(this.plugin, `Revision ${entry.vaultRevision}: ${this.historyPath}`, content).open();
    } catch (error) {
      new Notice(`Private Sync preview failed: ${errorMessage(error)}`, 10000);
    }
  }

  private async restoreRevision(entry: FileHistoryEntry): Promise<void> {
    try {
      if (entry.encrypted && this.isOlderEncryptedHistoryEntry(entry)) {
        const passphrase = await this.promptHistoryPassphrase(entry);
        if (!passphrase) return;
        await this.plugin.syncEngine.restoreHistoryEntryToLocalWithPassphrase(this.historyPath, entry, passphrase);
        new Notice(`Private Sync: restored revision ${entry.vaultRevision} locally and uploaded with the active encryption key.`, 10000);
        this.render();
        return;
      }
      await this.plugin.api.restoreRevision(this.plugin.settings.vaultId, entry.id);
      new Notice(`Private Sync: restored revision ${entry.vaultRevision}.`, 8000);
      await this.plugin.syncEngine.syncNow();
      this.render();
    } catch (error) {
      new Notice(`Private Sync restore failed: ${errorMessage(error)}`, 10000);
    }
  }

  private async encryptHistoryRevision(entry: FileHistoryEntry): Promise<void> {
    try {
      await this.plugin.syncEngine.encryptPlaintextHistoryEntry(entry);
      new Notice(`Private Sync: encrypted history revision ${entry.vaultRevision}.`, 8000);
      this.render();
    } catch (error) {
      new Notice(`Private Sync history encryption failed: ${errorMessage(error)}`, 10000);
    }
  }

  private async downloadHistoryEntryForUi(entry: FileHistoryEntry): Promise<ArrayBuffer> {
    if (!entry.encrypted || !this.isOlderEncryptedHistoryEntry(entry)) {
      try {
        return await this.plugin.syncEngine.downloadHistoryEntryPlain(entry);
      } catch (error) {
        if (!entry.encrypted) throw error;
      }
    }
    const passphrase = await this.promptHistoryPassphrase(entry);
    if (!passphrase) throw new Error("Passphrase was not entered.");
    return this.plugin.syncEngine.downloadHistoryEntryPlainWithPassphrase(entry, passphrase);
  }

  private isOlderEncryptedHistoryEntry(entry: FileHistoryEntry): boolean {
    return Boolean(entry.encrypted && (!entry.encryptionKeyId || entry.encryptionKeyId !== this.plugin.settings.encryptionKeyId));
  }

  private async promptHistoryPassphrase(entry: FileHistoryEntry): Promise<string | null> {
    const key = entry.encryptionKeyId ? await this.plugin.getEncryptionKeyForRevision(entry.encryptionKeyId) : null;
    return openHistoryPassphraseModal(this.plugin, {
      title: `Passphrase for revision ${entry.vaultRevision}`,
      description: key
        ? "This revision was encrypted with an older passphrase. Enter that passphrase for this action only."
        : "This older encrypted revision has no key metadata. Enter the passphrase that was used when it was uploaded.",
      keyCheck: key?.keyCheck ?? null
    });
  }

  private showEventDetails(event: SyncEvent): void {
    new TextPreviewModal(this.plugin, `Event: ${event.type}`, eventDetailsPretty(event)).open();
  }

  private actionButton(parent: Element, text: string, tone: "primary" | "success" | "info" | "danger" | "subtle"): HTMLButtonElement {
    return parent.createEl("button", { text, cls: `private-sync-button private-sync-button-${tone}` });
  }
}

function label(tab: Tab): string {
  if (tab === "vaults") return "Vaults";
  return tab.slice(0, 1).toUpperCase() + tab.slice(1);
}

function formatVaultLabel(name: string, id: string): string {
  return name ? `${name} (${id})` : id;
}

function historyEntrySize(entry: FileHistoryEntry): number {
  return entry.encrypted ? entry.plaintextSize ?? entry.size : entry.size;
}

class VaultRenameModal extends Modal {
  private input: HTMLInputElement | null = null;
  private saveButton: HTMLButtonElement | null = null;

  constructor(
    plugin: PrivateSyncPlugin,
    private readonly vault: ServerVault,
    private readonly onSave: (name: string) => Promise<void>
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("private-sync-vault-modal");
    this.contentEl.createEl("h2", { text: "Rename vault" });
    this.contentEl.createDiv({ text: `${this.vault.name} (${this.vault.id})`, cls: "private-sync-muted" });
    this.input = this.contentEl.createEl("input", {
      type: "text",
      value: this.vault.name,
      cls: "private-sync-modal-input"
    });
    this.input.oninput = () => this.updateState();
    this.input.onkeydown = (event) => {
      if (event.key === "Enter") this.save();
    };
    const actions = this.contentEl.createDiv({ cls: "private-sync-modal-actions" });
    actions.createEl("button", { text: "Cancel", cls: "private-sync-button private-sync-button-subtle" }).onclick = () => this.close();
    this.saveButton = actions.createEl("button", { text: "Save", cls: "private-sync-button private-sync-button-primary" });
    this.saveButton.onclick = () => this.save();
    this.updateState();
    this.input.focus();
    this.input.select();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private updateState(): void {
    if (!this.input || !this.saveButton) return;
    this.saveButton.disabled = this.input.value.trim().length === 0 || this.input.value.trim() === this.vault.name;
  }

  private async save(): Promise<void> {
    if (!this.input || !this.saveButton || this.saveButton.disabled) return;
    const name = this.input.value.trim();
    this.saveButton.disabled = true;
    this.saveButton.textContent = "Saving...";
    try {
      await this.onSave(name);
      this.close();
    } catch (error) {
      new Notice(`Private Sync vault rename failed: ${errorMessage(error)}`, 10000);
      this.saveButton.disabled = false;
      this.saveButton.textContent = "Save";
      this.updateState();
    }
  }
}

class VaultDeleteModal extends Modal {
  private readonly code = randomConfirmationCode();
  private input: HTMLInputElement | null = null;
  private deleteButton: HTMLButtonElement | null = null;

  constructor(
    plugin: PrivateSyncPlugin,
    private readonly vault: ServerVault,
    private readonly onDelete: () => Promise<void>
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("private-sync-vault-modal");
    this.contentEl.createEl("h2", { text: "Delete vault" });
    this.contentEl.createDiv({ text: `${this.vault.name} (${this.vault.id})`, cls: "private-sync-muted" });
    this.contentEl.createDiv({
      text: "This operation is irreversible. Deleted vault data cannot be recovered.",
      cls: "private-sync-vault-delete-warning"
    });
    this.contentEl.createDiv({ text: this.code, cls: "private-sync-confirmation-code" });
    this.input = this.contentEl.createEl("input", {
      type: "text",
      placeholder: "Type the code to confirm",
      cls: "private-sync-modal-input"
    });
    this.input.oninput = () => {
      this.input!.value = this.input!.value.toUpperCase();
      this.updateState();
    };
    this.input.onkeydown = (event) => {
      if (event.key === "Enter") this.delete();
    };
    const actions = this.contentEl.createDiv({ cls: "private-sync-modal-actions" });
    actions.createEl("button", { text: "Cancel", cls: "private-sync-button private-sync-button-subtle" }).onclick = () => this.close();
    this.deleteButton = actions.createEl("button", {
      text: "Delete permanently",
      cls: "private-sync-button private-sync-button-danger"
    });
    this.deleteButton.onclick = () => this.delete();
    this.updateState();
    this.input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private updateState(): void {
    if (!this.input || !this.deleteButton) return;
    this.deleteButton.disabled = this.input.value.trim() !== this.code;
  }

  private async delete(): Promise<void> {
    if (!this.deleteButton || this.deleteButton.disabled) return;
    this.deleteButton.disabled = true;
    this.deleteButton.textContent = "Deleting...";
    try {
      await this.onDelete();
      this.close();
    } catch (error) {
      new Notice(`Private Sync vault delete failed: ${errorMessage(error)}`, 10000);
      this.deleteButton.disabled = false;
      this.deleteButton.textContent = "Delete permanently";
      this.updateState();
    }
  }
}

function openHistoryPassphraseModal(
  plugin: PrivateSyncPlugin,
  input: { title: string; description: string; keyCheck: string | null }
): Promise<string | null> {
  return new Promise((resolve) => {
    new HistoryPassphraseModal(plugin, input, resolve).open();
  });
}

class HistoryPassphraseModal extends Modal {
  private input: HTMLInputElement | null = null;
  private submitButton: HTMLButtonElement | null = null;
  private resolved = false;

  constructor(
    plugin: PrivateSyncPlugin,
    private readonly details: { title: string; description: string; keyCheck: string | null },
    private readonly resolve: (passphrase: string | null) => void
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("private-sync-vault-modal");
    this.contentEl.createEl("h2", { text: this.details.title });
    this.contentEl.createDiv({ text: this.details.description, cls: "private-sync-muted" });
    this.input = this.contentEl.createEl("input", {
      type: "password",
      placeholder: "Old encryption passphrase",
      cls: "private-sync-modal-input"
    });
    this.input.oninput = () => this.updateState();
    this.input.onkeydown = (event) => {
      if (event.key === "Enter") this.submit();
    };
    const actions = this.contentEl.createDiv({ cls: "private-sync-modal-actions" });
    actions.createEl("button", { text: "Cancel", cls: "private-sync-button private-sync-button-subtle" }).onclick = () => this.finish(null);
    this.submitButton = actions.createEl("button", { text: "Use once", cls: "private-sync-button private-sync-button-primary" });
    this.submitButton.onclick = () => this.submit();
    this.updateState();
    this.input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }

  private updateState(): void {
    if (!this.input || !this.submitButton) return;
    this.submitButton.disabled = this.input.value.trim().length === 0;
  }

  private async submit(): Promise<void> {
    if (!this.input || !this.submitButton || this.submitButton.disabled) return;
    const passphrase = this.input.value.trim();
    this.submitButton.disabled = true;
    this.submitButton.textContent = "Checking...";
    try {
      if (this.details.keyCheck && !(await verifyEncryptionKeyCheck(this.details.keyCheck, passphrase))) {
        throw new Error("Passphrase does not match this revision key.");
      }
      this.finish(passphrase);
    } catch (error) {
      new Notice(`Private Sync history passphrase failed: ${errorMessage(error)}`, 10000);
      this.submitButton.disabled = false;
      this.submitButton.textContent = "Use once";
      this.updateState();
    }
  }

  private finish(passphrase: string | null): void {
    this.resolved = true;
    this.resolve(passphrase);
    this.close();
  }
}

function randomConfirmationCode(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const values = new Uint8Array(6);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
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

function formatSizeInfo(size: { bytes: number; diskBytes: number }): string {
  if (size.diskBytes === size.bytes) return formatBytes(size.bytes);
  return `${formatBytes(size.diskBytes)} on disk · ${formatBytes(size.bytes)} logical`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
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
