import { Notice, TFile, normalizePath } from "obsidian";
import { ApiClient } from "./apiClient";
import { sha256, uuid } from "./crypto";
import { chunkSizeBytes, shouldAutoSyncPath, shouldUseChunkedTransfer } from "./filePolicy";
import { getLocalFileStat, listLocalCommunityPluginIds, listLocalSyncFiles, readLocalBinary, trashLocalPath, type LocalSyncFile, writeLocalBinary } from "./localFiles";
import type { LocalIndexStore } from "./localIndex";
import type PrivateSyncPlugin from "./plugin";
import { collectCommunityPluginIds, getCommunityPluginId, shouldSyncPath } from "./settingsSyncPolicy";
import type { PendingOperation, ServerChange } from "./types";
import { openVaultConnectionModal } from "./vaultConnectionModal";
import { buildLocalVaultManifest } from "./vaultManifest";

type RemoteSnapshot = {
  files: Map<string, ServerChange>;
  latestRevision: number;
};

type ApplyServerChangeResult = "applied" | "queued_upload";

type LineChange = {
  baseStart: number;
  baseEnd: number;
  replacement: string[];
};

type ThreeWayMergeResult = {
  text: string;
  hasConflicts: boolean;
};

export class SyncEngine {
  private running = false;

  constructor(
    private readonly plugin: PrivateSyncPlugin,
    private readonly indexStore: LocalIndexStore,
    private readonly api: ApiClient
  ) {}

  async pairDevice(input: { password?: string; recoveryPairingCode?: string } = {}): Promise<void> {
    if (this.plugin.handleOfflineSyncAttempt()) return;
    const settings = this.plugin.settings;
    const password = input.password ?? settings.password;
    if (!settings.serverUrl.trim()) {
      throw new Error("Enter the Private Sync server URL before pairing.");
    }
    if (!password.trim()) {
      throw new Error("Enter the pairing password before pairing.");
    }
    if (!settings.deviceName.trim()) {
      throw new Error("Enter this device name before pairing.");
    }
    await this.api.serverInfo();
    const response = await this.api.requestDevice({
      password,
      deviceName: settings.deviceName,
      deviceType: settings.deviceType,
      recoveryPairingCode: input.recoveryPairingCode
    });
    if (response.status === "approved") {
      await this.savePairedDevice(response.deviceId, response.deviceToken);
    } else {
      new Notice(`Private Sync: pairing request pending (${response.requestId}). Waiting for approval.`, 10000);
      this.waitForPairingApproval(response.requestId, password).catch((error) => {
        new Notice(`Private Sync pairing failed: ${(error as Error).message}`, 10000);
      });
    }
  }

  async syncNow(): Promise<void> {
    if (this.plugin.handleOfflineSyncAttempt()) return;
    if (!this.plugin.settings.vaultLinked) {
      new Notice("Private Sync: choose and link a server vault before syncing.", 10000);
      return;
    }
    if (this.running) return;
    this.running = true;
    try {
      await this.scanLocalChanges();
      await this.pushQueue();
      await this.pullChanges();
      await this.reconcileResolvedLocalConflicts();
      await this.recordSyncStateIfComplete();
      this.plugin.refreshView();
    } finally {
      this.running = false;
    }
  }

  async bootstrapLocalToRemote(): Promise<void> {
    await this.plugin.saveSettings();
    await this.indexStore.reset();
    await this.scanLocalChanges();
    await this.pushQueue();
    await this.recordSyncStateIfComplete();
    this.plugin.refreshView();
  }

  async adoptMatchingRemoteIndex(): Promise<void> {
    const index = this.indexStore.get();
    index.lastAppliedRevision = 0;
    index.files = {};
    index.queue = [];
    const response = await this.api.getChanges(this.plugin.settings.vaultId, 0);
    for (const change of response.changes) {
      const stat = await getLocalFileStat(this.plugin, change.path);
      index.files[change.path] = {
        path: change.path,
        localHash: change.deleted ? null : change.contentHash,
        size: change.deleted ? 0 : change.size,
        mtime: stat?.mtime ?? Date.now(),
        serverRevisionId: change.fileRevisionId,
        status: "synced",
        wasSynced: true
      };
      index.lastAppliedRevision = Math.max(index.lastAppliedRevision, change.vaultRevision);
    }
    await this.indexStore.save();
    await this.recordSyncStateIfComplete();
    this.plugin.refreshView();
  }

  async finishInitialVaultConnection(): Promise<void> {
    const manifest = await buildLocalVaultManifest(this.plugin);
    const assessment = await this.api.assessVaultConnection(this.plugin.settings.vaultId, {
      localVaultInstanceId: this.plugin.settings.localVaultInstanceId,
      localFileCount: manifest.fileCount,
      localManifestHash: manifest.manifestHash
    });
    if (assessment.riskLevel === "empty") {
      const decision = await openVaultConnectionModal(this.plugin, {
        vaultId: this.plugin.settings.vaultId,
        localManifest: manifest,
        assessment
      });
      if (decision !== "replace_remote") {
        new Notice("Private Sync: paired, but initial upload was cancelled.", 10000);
        return;
      }
      await this.replaceRemoteWithLocal();
      this.plugin.settings.vaultLinked = true;
      await this.plugin.saveSettings();
      new Notice("Private Sync: local files uploaded to the empty server vault.", 10000);
      return;
    }

    const decision = await openVaultConnectionModal(this.plugin, {
      vaultId: this.plugin.settings.vaultId,
      localManifest: manifest,
      assessment
    });
    if (decision === "replace_local") {
      await this.replaceLocalWithRemote();
      this.plugin.settings.vaultLinked = true;
      await this.plugin.saveSettings();
      new Notice("Private Sync: local files replaced with the server vault state.", 10000);
      return;
    }
    if (decision === "replace_remote") {
      await this.replaceRemoteWithLocal();
      this.plugin.settings.vaultLinked = true;
      await this.plugin.saveSettings();
      new Notice("Private Sync: server vault replaced with the local state.", 10000);
      return;
    }
    new Notice("Private Sync: paired, but vault linking was cancelled.", 10000);
  }

  async replaceLocalWithRemote(): Promise<void> {
    const snapshot = await this.getRemoteSnapshot();
    await this.indexStore.reset();
    const index = this.indexStore.get();
    const remotePaths = new Set(snapshot.files.keys());
    const remotePluginIds = collectCommunityPluginIds(remotePaths, this.plugin.app.vault.configDir);
    const localPluginIds = await this.getLocalCommunityPluginIds();

    for (const file of await this.getSyncableLocalFiles()) {
      const path = normalizePath(file.path);
      if (this.shouldKeepLocalPluginPath(path, remotePluginIds, localPluginIds)) continue;
      if (!remotePaths.has(path)) {
        await trashLocalPath(this.plugin, path);
      }
    }

    for (const change of [...snapshot.files.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      if (!shouldSyncPath(change.path, this.plugin.settings, this.plugin.app.vault.configDir)) continue;
      if (this.shouldKeepLocalPluginPath(change.path, remotePluginIds, localPluginIds)) continue;
      const content = shouldUseChunkedTransfer(change.size, this.plugin.settings)
        ? await this.api.downloadChunked(this.plugin.settings.vaultId, change.path, change.size, chunkSizeBytes(this.plugin.settings))
        : await this.api.download(this.plugin.settings.vaultId, change.path);
      await this.writeFile(change.path, content);
      index.files[change.path] = {
        path: change.path,
        localHash: change.contentHash,
        size: change.size,
        mtime: Date.now(),
        serverRevisionId: change.fileRevisionId,
        status: "synced",
        wasSynced: true
      };
    }
    index.lastAppliedRevision = snapshot.latestRevision;
    await this.indexStore.save();
    await this.uploadLocalOnlyPlugins(remotePluginIds);
    await this.pullChanges();
    await this.recordSyncStateIfComplete();
    this.plugin.refreshView();
  }

  async replaceRemoteWithLocal(): Promise<void> {
    const snapshot = await this.getRemoteSnapshot();
    await this.indexStore.reset();
    const index = this.indexStore.get();
    const seen = new Set<string>();
    const remotePluginIds = collectCommunityPluginIds(snapshot.files.keys(), this.plugin.app.vault.configDir);
    const localPluginIds = await this.getLocalCommunityPluginIds();

    for (const file of await this.getSyncableLocalFiles()) {
      const path = normalizePath(file.path);
      if (this.shouldSkipLocalPluginUpload(path, remotePluginIds)) continue;
      seen.add(path);
      const content = await readLocalBinary(this.plugin, path);
      const localHash = await sha256(content);
      const remote = snapshot.files.get(path);
      const isAlreadySynced = remote?.contentHash === localHash && remote.size === file.size;
      index.files[path] = {
        path,
        localHash,
        size: file.size,
        mtime: file.mtime,
        serverRevisionId: remote?.fileRevisionId ?? null,
        status: isAlreadySynced ? "synced" : "dirty_local",
        wasSynced: isAlreadySynced
      };
      if (!isAlreadySynced) {
        await this.enqueueFile(file, remote ? "update" : "create", remote?.fileRevisionId ?? null, localHash);
      }
    }

    for (const [path, remote] of snapshot.files) {
      if (seen.has(path)) continue;
      if (!shouldSyncPath(path, this.plugin.settings, this.plugin.app.vault.configDir)) continue;
      if (this.shouldSkipRemotePluginDelete(path, localPluginIds)) continue;
      await this.indexStore.enqueue({
        clientChangeId: uuid(),
        type: "delete",
        path,
        baseRevisionId: remote.fileRevisionId,
        detectedAt: new Date().toISOString()
      });
    }
    for (const change of [...snapshot.files.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      const pluginId = getCommunityPluginId(change.path, this.plugin.app.vault.configDir);
      if (!pluginId || localPluginIds.has(pluginId)) continue;
      await this.applyServerChange(change, localPluginIds);
    }

    index.lastAppliedRevision = snapshot.latestRevision;
    await this.indexStore.save();
    await this.pushQueue();
    await this.pullChanges();
    await this.recordSyncStateIfComplete();
    this.plugin.refreshView();
  }

  async scanLocalChanges(): Promise<void> {
    const index = this.indexStore.get();
    const seen = new Set<string>();
    const files = await this.getAllLocalFilesForScan();
    const remotePluginIds = await this.getRemoteCommunityPluginIdsForLocalScan();
    const localPluginIds = await this.getLocalCommunityPluginIds();
    for (const file of files) {
      const path = normalizePath(file.path);
      seen.add(path);
      if (this.shouldSkipLocalPluginUpload(path, remotePluginIds) || !this.isSyncableLocalFile(file)) {
        const previous = index.files[path];
        index.files[path] = {
          path,
          localHash: previous?.localHash ?? null,
          size: file.size,
          mtime: file.mtime,
          serverRevisionId: previous?.serverRevisionId ?? null,
          status: "ignored",
          wasSynced: previous?.wasSynced ?? false
        };
        continue;
      }
      const previous = index.files[path];
      if (previous && previous.size === file.size && previous.mtime === file.mtime && previous.status === "synced") {
        continue;
      }
      const content = await readLocalBinary(this.plugin, path);
      const localHash = await sha256(content);
      if (!previous) {
        index.files[path] = {
          path,
          localHash,
          size: file.size,
          mtime: file.mtime,
          serverRevisionId: null,
          status: "dirty_local",
          wasSynced: false
        };
        await this.enqueueFile(file, "create", null, localHash);
      } else if (previous.localHash !== localHash && previous.status !== "conflict" && previous.status !== "locked_by_request") {
        previous.localHash = localHash;
        previous.size = file.size;
        previous.mtime = file.mtime;
        previous.status = "dirty_local";
        await this.enqueueFile(file, previous.wasSynced ? "update" : "create", previous.serverRevisionId, localHash);
      }
    }

    for (const [path, record] of Object.entries(index.files)) {
      const hasQueuedOperation = index.queue.some((operation) => operation.path === path);
      const protectedPluginPath = this.shouldSkipRemotePluginDelete(path, localPluginIds);
      if (
        !seen.has(path) &&
        shouldSyncPath(path, this.plugin.settings, this.plugin.app.vault.configDir) &&
        !protectedPluginPath &&
        record.wasSynced &&
        record.status !== "deleted_local" &&
        record.status !== "conflict" &&
        record.status !== "locked_by_request" &&
        !isSyncedDeletedRecord(record) &&
        !hasQueuedOperation
      ) {
        await this.indexStore.enqueue({
          clientChangeId: uuid(),
          type: "delete",
          path,
          baseRevisionId: record.serverRevisionId,
          detectedAt: new Date().toISOString()
        });
      }
    }
    await this.indexStore.save();
  }

  async pushQueue(): Promise<void> {
    const index = this.indexStore.get();
    if (index.queue.length === 0) return;
    const skippedOperationIds: string[] = [];
    const uploadPayloads = new Map<string, ArrayBuffer>();
    const batchOperations: PendingOperation[] = [];
    for (const operation of index.queue) {
      if (!shouldSyncPath(operation.path, this.plugin.settings, this.plugin.app.vault.configDir)) {
        skippedOperationIds.push(operation.clientChangeId);
        continue;
      }
      if (operation.type === "delete") {
        batchOperations.push(operation);
        continue;
      }
      const stat = await getLocalFileStat(this.plugin, operation.path);
      if (!stat) continue;
      const content = await readLocalBinary(this.plugin, operation.path);
      const contentHash = await sha256(content);
      operation.contentHash = contentHash;
      operation.size = content.byteLength;
      const record = index.files[operation.path];
      if (record) {
        record.localHash = contentHash;
        record.size = stat.size;
        record.mtime = stat.mtime;
      }
      uploadPayloads.set(operation.clientChangeId, content);
      batchOperations.push(operation);
    }
    if (skippedOperationIds.length > 0) {
      await this.indexStore.removeFromQueue(skippedOperationIds);
    }
    if (batchOperations.length === 0) {
      await this.indexStore.save();
      return;
    }
    await this.indexStore.save();
    const { batchId } = await this.api.createBatch(this.plugin.settings.vaultId, batchOperations);
    for (const operation of batchOperations) {
      if (operation.type === "delete") continue;
      const content = uploadPayloads.get(operation.clientChangeId);
      if (!content) continue;
      const record = index.files[operation.path];
      if (record) record.status = "uploading";
      await this.indexStore.save();
      if (shouldUseChunkedTransfer(content.byteLength, this.plugin.settings)) {
        await this.api.uploadChunked(this.plugin.settings.vaultId, batchId, operation, content, chunkSizeBytes(this.plugin.settings));
      } else {
        await this.api.upload(this.plugin.settings.vaultId, batchId, operation, content);
      }
      if (record) record.status = "uploaded_waiting_ack";
    }
    const result = await this.api.commit(this.plugin.settings.vaultId, batchId);
    if (result.status === "committed" && result.revision !== undefined) {
      for (const operation of batchOperations) {
        const record = index.files[operation.path];
        if (record) {
          record.serverRevisionId = result.revision;
          record.status = "synced";
          record.wasSynced = true;
          if (operation.type === "delete") {
            record.localHash = null;
            record.size = 0;
            record.mtime = Date.now();
          }
        }
      }
      await this.indexStore.removeFromQueue(batchOperations.map((operation) => operation.clientChangeId));
    } else if (result.status === "conflict") {
      const autoMergedIds = await this.tryAutoMergeConflicts(batchOperations);
      for (const operation of batchOperations) {
        if (autoMergedIds.has(operation.clientChangeId)) continue;
        const record = index.files[operation.path];
        if (record) {
          record.status = "conflict";
          await this.plugin.recordSyncEvent({
            type: "conflict",
            path: operation.path,
            message: `Conflict detected for ${operation.path}`,
            details: { clientChangeId: operation.clientChangeId, conflictIds: result.conflicts ?? [] }
          });
        }
      }
      await this.indexStore.save();
      if (autoMergedIds.size > 0) {
        await this.pushQueue();
      }
      if (autoMergedIds.size < batchOperations.length) new Notice("Private Sync: conflict detected.");
    } else if (result.status === "waiting_for_decision") {
      for (const operation of batchOperations) {
        const record = index.files[operation.path];
        if (record) record.status = "locked_by_request";
      }
      await this.indexStore.save();
      await this.plugin.recordSyncEvent({
        type: "conflict",
        message: "Server requires a decision before syncing.",
        details: { requestId: result.requestId }
      });
      new Notice("Private Sync: server requires a decision.");
    }
  }

  async pullChanges(): Promise<void> {
    const index = this.indexStore.get();
    const response = await this.api.getChanges(this.plugin.settings.vaultId, index.lastAppliedRevision);
    const localPluginIds = await this.getLocalCommunityPluginIds();
    const finalChangesByPath = new Map<string, ServerChange>();
    let latestRevision = index.lastAppliedRevision;
    for (const change of [...response.changes].sort((left, right) => left.vaultRevision - right.vaultRevision)) {
      finalChangesByPath.set(change.path, change);
      latestRevision = Math.max(latestRevision, change.vaultRevision);
    }

    let queuedUpload = false;
    for (const change of finalChangesByPath.values()) {
      const result = await this.applyServerChange(change, localPluginIds);
      queuedUpload = queuedUpload || result === "queued_upload";
    }
    index.lastAppliedRevision = latestRevision;
    await this.indexStore.save();
    if (queuedUpload) await this.pushQueue();
  }

  async resolveLocalConflict(path: string, strategy: "keep_local" | "use_server"): Promise<void> {
    if (this.plugin.handleOfflineSyncAttempt()) return;
    const index = this.indexStore.get();
    const record = index.files[path];
    if (!record) throw new Error(`No local record for ${path}.`);
    if (strategy === "use_server") {
      await this.indexStore.removePathFromQueue(path);
      const history = await this.api.history(this.plugin.settings.vaultId, path);
      const current = history.history[0];
      if (!current) throw new Error("Server version is unavailable.");
      if (current.deleted) {
        await trashLocalPath(this.plugin, path);
        index.files[path] = {
          path,
          localHash: null,
          size: 0,
          mtime: Date.now(),
          serverRevisionId: current.id,
          status: "synced",
          wasSynced: true
        };
      } else {
        const content = await this.api.download(this.plugin.settings.vaultId, path);
        await this.writeFile(path, content);
        index.files[path] = {
          path,
          localHash: current.contentHash,
          size: current.size,
          mtime: Date.now(),
          serverRevisionId: current.id,
          status: "synced",
          wasSynced: true
        };
      }
      await this.indexStore.save();
      await this.resolveRemoteConflicts(path, "cancelled", { strategy });
      await this.plugin.recordSyncEvent({
        type: "manual_resolution",
        path,
        message: `Used server version for ${path}`,
        details: { strategy }
      });
      new Notice(`Private Sync: using server version for ${path}.`, 8000);
      this.plugin.refreshView();
      return;
    }

    const stat = await getLocalFileStat(this.plugin, path);
    if (!stat) throw new Error(`Local file not found: ${path}.`);
    const history = await this.api.history(this.plugin.settings.vaultId, path);
    const current = history.history[0];
    const content = await readLocalBinary(this.plugin, path);
    const localHash = await sha256(content);
    record.localHash = localHash;
    record.size = stat.size;
    record.mtime = stat.mtime;
    record.serverRevisionId = current?.id ?? record.serverRevisionId;
    record.status = "dirty_local";
    await this.indexStore.removePathFromQueue(path);
    await this.indexStore.enqueue({
      clientChangeId: uuid(),
      type: record.wasSynced ? "update" : "create",
      path,
      baseRevisionId: current?.id ?? record.serverRevisionId,
      contentHash: localHash,
      size: stat.size,
      detectedAt: new Date().toISOString()
    });
    await this.pushQueue();
    await this.pullChanges();
    await this.resolveRemoteConflicts(path, "resolved", { strategy });
    await this.plugin.recordSyncEvent({
      type: "manual_resolution",
      path,
      message: `Kept local version for ${path}`,
      details: { strategy }
    });
    this.plugin.refreshView();
    new Notice(`Private Sync: kept local version for ${path}.`, 8000);
  }

  private async applyServerChange(change: ServerChange, localPluginIds: Set<string>): Promise<ApplyServerChangeResult> {
    const index = this.indexStore.get();
    const record = index.files[change.path];
    if (!shouldSyncPath(change.path, this.plugin.settings, this.plugin.app.vault.configDir)) return "applied";
    if (this.shouldKeepLocalPluginPath(change.path, undefined, localPluginIds)) return "applied";
    if (change.deviceId && change.deviceId === this.plugin.settings.deviceId) {
      if (record) {
        record.serverRevisionId = change.fileRevisionId;
        record.wasSynced = true;
        record.status = record.localHash === change.contentHash ? "synced" : "dirty_local";
      }
      return "applied";
    }
    if (record?.status === "conflict") {
      record.status = "conflict";
      return "applied";
    }
    if (record?.status === "dirty_local" || record?.status === "pending_upload") {
      return this.mergeRemoteChangeWithLocal(change, record);
    }
    if (record && (await this.hasUnindexedLocalChange(change.path, record.localHash))) {
      const result = await this.mergeRemoteChangeWithLocal(change, record);
      if (result !== "queued_upload") new Notice(`Private Sync: local edits preserved; conflict detected for ${change.path}.`, 10000);
      return result;
    }
    if (change.deleted) {
      await trashLocalPath(this.plugin, change.path);
      index.files[change.path] = {
        path: change.path,
        localHash: null,
        size: 0,
        mtime: Date.now(),
        serverRevisionId: change.fileRevisionId,
        status: "synced",
        wasSynced: true
      };
      return "applied";
    }
    const content = await this.api.downloadRevision(this.plugin.settings.vaultId, change.fileRevisionId);
    await this.writeFile(change.path, content);
    index.files[change.path] = {
      path: change.path,
      localHash: change.contentHash,
      size: change.size,
      mtime: Date.now(),
      serverRevisionId: change.fileRevisionId,
      status: "synced",
      wasSynced: true
    };
    return "applied";
  }

  private async mergeRemoteChangeWithLocal(change: ServerChange, record: { path: string; serverRevisionId: number | null }): Promise<ApplyServerChangeResult> {
    const index = this.indexStore.get();
    if (change.deleted || !isTextLikePath(change.path) || !record.serverRevisionId) {
      const currentRecord = index.files[change.path];
      if (currentRecord) currentRecord.status = "conflict";
      return "applied";
    }

    const stat = await getLocalFileStat(this.plugin, change.path);
    if (!stat) {
      const currentRecord = index.files[change.path];
      if (currentRecord) currentRecord.status = "conflict";
      return "applied";
    }

    const [baseContent, localContent, remoteContent] = await Promise.all([
      this.api.downloadRevision(this.plugin.settings.vaultId, record.serverRevisionId).catch(() => null),
      readLocalBinary(this.plugin, change.path),
      this.api.downloadRevision(this.plugin.settings.vaultId, change.fileRevisionId)
    ]);
    if (!baseContent) {
      const currentRecord = index.files[change.path];
      if (currentRecord) currentRecord.status = "conflict";
      return "applied";
    }

    const baseText = decodeUtf8(baseContent);
    const localText = decodeUtf8(localContent);
    const remoteText = decodeUtf8(remoteContent);
    const merge = mergeTextThreeWay(baseText, localText, remoteText);
    if (!merge) {
      const currentRecord = index.files[change.path];
      if (currentRecord) currentRecord.status = "conflict";
      return "applied";
    }

    const mergedContent = encodeUtf8(merge.text);
    await this.writeFile(change.path, mergedContent);
    const mergedHash = await sha256(mergedContent);
    index.files[change.path] = {
      path: change.path,
      localHash: mergedHash,
      size: mergedContent.byteLength,
      mtime: Date.now(),
      serverRevisionId: change.fileRevisionId,
      status: merge.hasConflicts ? "conflict" : "dirty_local",
      wasSynced: true
    };
    await this.indexStore.removePathFromQueue(change.path);
    await this.plugin.recordSyncEvent({
      type: merge.hasConflicts ? "conflict" : "auto_merge",
      path: change.path,
      message: merge.hasConflicts ? `Merged non-conflicting changes but kept conflict markers in ${change.path}` : `Merged local and remote changes in ${change.path}`,
      details: {
        strategy: merge.hasConflicts ? "three_way_with_conflict_markers" : "three_way_auto_merge",
        serverRevisionId: change.fileRevisionId,
        baseRevisionId: record.serverRevisionId
      }
    });

    if (merge.hasConflicts) return "applied";
    await this.indexStore.enqueue({
      clientChangeId: uuid(),
      type: "update",
      path: change.path,
      baseRevisionId: change.fileRevisionId,
      contentHash: mergedHash,
      size: mergedContent.byteLength,
      detectedAt: new Date().toISOString()
    });
    return "queued_upload";
  }

  private async getRemoteSnapshot(): Promise<RemoteSnapshot> {
    const response = await this.api.getChanges(this.plugin.settings.vaultId, 0);
    const files = new Map<string, ServerChange>();
    let latestRevision = 0;
    for (const change of response.changes) {
      latestRevision = Math.max(latestRevision, change.vaultRevision);
      if (change.deleted) {
        files.delete(change.path);
      } else {
        files.set(change.path, change);
      }
    }
    return { files, latestRevision };
  }

  private async getSyncableLocalFiles(): Promise<LocalSyncFile[]> {
    return listLocalSyncFiles(this.plugin);
  }

  private async getAllLocalFilesForScan(): Promise<LocalSyncFile[]> {
    const files = new Map<string, LocalSyncFile>();
    for (const file of this.plugin.app.vault.getFiles()) {
      const path = normalizePath(file.path);
      files.set(path, {
        path,
        size: file.stat.size,
        mtime: file.stat.mtime,
        file
      });
    }
    for (const file of await listLocalSyncFiles(this.plugin)) {
      files.set(file.path, file);
    }
    return [...files.values()];
  }

  private isSyncableLocalFile(file: LocalSyncFile): boolean {
    return shouldSyncPath(file.path, this.plugin.settings, this.plugin.app.vault.configDir) && shouldAutoSyncPath(file.path, file.size, this.plugin.settings);
  }

  private async getLocalCommunityPluginIds(): Promise<Set<string>> {
    const ids = await listLocalCommunityPluginIds(this.plugin);
    for (const pluginId of collectCommunityPluginIds(Object.keys(this.indexStore.get().files), this.plugin.app.vault.configDir)) ids.add(pluginId);
    for (const pluginId of collectCommunityPluginIds(this.plugin.app.vault.getFiles().map((file) => normalizePath(file.path)), this.plugin.app.vault.configDir)) ids.add(pluginId);
    return ids;
  }

  private async getRemoteCommunityPluginIdsForLocalScan(): Promise<Set<string>> {
    if (!this.plugin.settings.syncObsidianSettings || !this.plugin.settings.syncCommunityPlugins) return new Set();
    const snapshot = await this.getRemoteSnapshot();
    return collectCommunityPluginIds(snapshot.files.keys(), this.plugin.app.vault.configDir);
  }

  private async uploadLocalOnlyPlugins(remotePluginIds: Set<string>): Promise<void> {
    if (!this.plugin.settings.syncObsidianSettings || !this.plugin.settings.syncCommunityPlugins) return;
    const index = this.indexStore.get();
    for (const file of await this.getSyncableLocalFiles()) {
      const pluginId = getCommunityPluginId(file.path, this.plugin.app.vault.configDir);
      if (!pluginId || remotePluginIds.has(pluginId)) continue;
      const content = await readLocalBinary(this.plugin, file.path);
      const localHash = await sha256(content);
      index.files[file.path] = {
        path: file.path,
        localHash,
        size: file.size,
        mtime: file.mtime,
        serverRevisionId: null,
        status: "dirty_local",
        wasSynced: false
      };
      await this.enqueueFile(file, "create", null, localHash);
    }
    await this.pushQueue();
  }

  private shouldSkipLocalPluginUpload(path: string, remotePluginIds: Set<string>): boolean {
    if (!this.plugin.settings.syncObsidianSettings || !this.plugin.settings.syncCommunityPlugins) return false;
    const pluginId = getCommunityPluginId(path, this.plugin.app.vault.configDir);
    return Boolean(pluginId && remotePluginIds.has(pluginId));
  }

  private shouldKeepLocalPluginPath(path: string, remotePluginIds: Set<string> | undefined, localPluginIds: Set<string>): boolean {
    if (!this.plugin.settings.syncObsidianSettings || !this.plugin.settings.syncCommunityPlugins) return false;
    const pluginId = getCommunityPluginId(path, this.plugin.app.vault.configDir);
    if (!pluginId) return false;
    return localPluginIds.has(pluginId) && (!remotePluginIds || remotePluginIds.has(pluginId));
  }

  private shouldSkipRemotePluginDelete(path: string, localPluginIds: Set<string>): boolean {
    if (!this.plugin.settings.syncObsidianSettings || !this.plugin.settings.syncCommunityPlugins) return false;
    const pluginId = getCommunityPluginId(path, this.plugin.app.vault.configDir);
    return Boolean(pluginId);
  }

  private async enqueueFile(file: LocalSyncFile, type: "create" | "update", baseRevisionId: number | null, contentHash: string): Promise<void> {
    await this.indexStore.enqueue({
      clientChangeId: uuid(),
      type,
      path: file.path,
      baseRevisionId,
      contentHash,
      size: file.size,
      detectedAt: new Date().toISOString()
    });
  }

  private async writeFile(path: string, content: ArrayBuffer): Promise<void> {
    await writeLocalBinary(this.plugin, path, content);
  }

  private async hasUnindexedLocalChange(path: string, indexedHash: string | null): Promise<boolean> {
    const stat = await getLocalFileStat(this.plugin, path);
    if (!stat) return false;
    const content = await readLocalBinary(this.plugin, path);
    const currentHash = await sha256(content);
    return currentHash !== indexedHash;
  }

  private async tryAutoMergeConflicts(operations: PendingOperation[]): Promise<Set<string>> {
    const mergedIds = new Set<string>();
    const mergedPaths = new Set<string>();
    for (const operation of operations) {
      if (mergedPaths.has(operation.path)) {
        mergedIds.add(operation.clientChangeId);
        continue;
      }
      const merged = await this.tryAutoMergeConflict(operation);
      if (merged) {
        mergedPaths.add(operation.path);
        for (const matchingOperation of operations) {
          if (matchingOperation.path === operation.path) mergedIds.add(matchingOperation.clientChangeId);
        }
      }
    }
    return mergedIds;
  }

  private async tryAutoMergeConflict(operation: PendingOperation): Promise<boolean> {
    const index = this.indexStore.get();
    if (operation.type === "delete") return this.tryAutoResolveDeleteConflict(operation);

    const file = this.plugin.app.vault.getAbstractFileByPath(operation.path);
    const record = index.files[operation.path];
    if (!isAutoMergeCandidate(operation, record, file)) return false;

    const history = await this.api.history(this.plugin.settings.vaultId, operation.path);
    const current = history.history[0];
    if (!current || current.deleted) return false;

    const [serverContent, localContent, baseContent] = await Promise.all([
      this.api.download(this.plugin.settings.vaultId, operation.path),
      readLocalBinary(this.plugin, operation.path),
      operation.baseRevisionId ? this.api.downloadRevision(this.plugin.settings.vaultId, operation.baseRevisionId).catch(() => null) : null
    ]);
    const serverText = decodeUtf8(serverContent);
    const localText = decodeUtf8(localContent);
    const baseText = baseContent ? decodeUtf8(baseContent) : null;
    const merge = mergeServerWithUniqueLocal(serverText, localText, baseText);
    if (!merge) return false;

    const mergedContent = encodeUtf8(merge.text);
    await this.writeFile(operation.path, mergedContent);
    const mergedHash = await sha256(mergedContent);
    index.files[operation.path] = {
      path: operation.path,
      localHash: mergedHash,
      size: mergedContent.byteLength,
      mtime: Date.now(),
      serverRevisionId: current.id,
      status: "dirty_local",
      wasSynced: true
    };
    await this.indexStore.removePathFromQueue(operation.path);
    if (merge.appendedLineCount > 0) {
      await this.indexStore.enqueue({
        clientChangeId: uuid(),
        type: "update",
        path: operation.path,
        baseRevisionId: current.id,
        contentHash: mergedHash,
        size: mergedContent.byteLength,
        detectedAt: new Date().toISOString()
      });
    } else {
      index.files[operation.path].status = "synced";
    }
    await this.resolveRemoteConflicts(operation.path, "resolved", {
      strategy: "auto_merge_unique_local",
      appendedLineCount: merge.appendedLineCount,
      serverRevisionId: current.id
    });
    await this.plugin.recordSyncEvent({
      type: "auto_merge",
      path: operation.path,
      message: `Auto-merged conflict in ${operation.path}`,
      details: {
        strategy: "auto_merge_unique_local",
        appendedLineCount: merge.appendedLineCount,
        serverRevisionId: current.id
      }
    });
    new Notice(`Private Sync: auto-merged conflict in ${operation.path}.`, 10000);
    await this.reconcileResolvedLocalConflict(operation.path);
    return true;
  }

  private async tryAutoResolveDeleteConflict(operation: PendingOperation): Promise<boolean> {
    const index = this.indexStore.get();
    const history = await this.api.history(this.plugin.settings.vaultId, operation.path);
    const current = history.history[0];
    if (!current?.deleted) return false;

    await this.indexStore.removePathFromQueue(operation.path);
    index.files[operation.path] = {
      path: operation.path,
      localHash: null,
      size: 0,
      mtime: Date.now(),
      serverRevisionId: current.id,
      status: "synced",
      wasSynced: true
    };
    await this.resolveRemoteConflicts(operation.path, "resolved", {
      strategy: "auto_delete_already_deleted",
      serverRevisionId: current.id
    });
    await this.plugin.recordSyncEvent({
      type: "auto_merge",
      path: operation.path,
      message: `Resolved delete conflict in ${operation.path}`,
      details: {
        strategy: "auto_delete_already_deleted",
        serverRevisionId: current.id
      }
    });
    new Notice(`Private Sync: resolved delete conflict in ${operation.path}.`, 10000);
    await this.reconcileResolvedLocalConflict(operation.path);
    return true;
  }

  private async reconcileResolvedLocalConflicts(): Promise<void> {
    const index = this.indexStore.get();
    const paths = Object.values(index.files)
      .filter((record) => record.status === "conflict" || record.status === "locked_by_request")
      .map((record) => record.path);
    for (const path of paths) await this.reconcileResolvedLocalConflict(path);
  }

  private async reconcileResolvedLocalConflict(path: string): Promise<void> {
    const index = this.indexStore.get();
    const record = index.files[path];
    if (!record || (record.status !== "conflict" && record.status !== "locked_by_request")) return;
    if (index.queue.some((operation) => operation.path === path)) return;
    const pendingConflicts = await this.api.conflicts(this.plugin.settings.vaultId);
    if (pendingConflicts.conflicts.some((conflict) => conflict.filePath === path)) return;

    const history = await this.api.history(this.plugin.settings.vaultId, path);
    const current = history.history[0];
    if (!current) return;
    if (current.deleted) {
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) return;
      record.localHash = null;
      record.size = 0;
      record.mtime = Date.now();
      record.serverRevisionId = current.id;
      record.status = "synced";
      record.wasSynced = true;
      await this.indexStore.save();
      return;
    }

    const stat = await getLocalFileStat(this.plugin, path);
    if (!stat) return;
    const content = await readLocalBinary(this.plugin, path);
    const localHash = await sha256(content);
    if (localHash !== current.contentHash) return;
    record.localHash = localHash;
    record.size = stat.size;
    record.mtime = stat.mtime;
    record.serverRevisionId = current.id;
    record.status = "synced";
    record.wasSynced = true;
    await this.indexStore.save();
  }

  private async resolveRemoteConflicts(path: string, status: "resolved" | "cancelled", decision: unknown): Promise<void> {
    const response = await this.api.conflicts(this.plugin.settings.vaultId);
    const conflicts = response.conflicts.filter((conflict) => conflict.filePath === path);
    for (const conflict of conflicts) {
      await this.api.resolveConflict(this.plugin.settings.vaultId, conflict.id, status, decision);
    }
  }

  private async recordSyncStateIfComplete(): Promise<void> {
    if (!this.plugin.settings.deviceToken || !this.plugin.settings.localVaultInstanceId) return;
    const index = this.indexStore.get();
    const incomplete = Object.values(index.files).some((record) =>
      ["dirty_local", "pending_upload", "uploading", "uploaded_waiting_ack", "pending_download", "conflict", "locked_by_request", "deleted_local", "failed"].includes(
        record.status
      )
    );
    if (index.queue.length > 0 || incomplete) return;
    const manifest = await buildLocalVaultManifest(this.plugin);
    await this.api.recordSyncState(this.plugin.settings.vaultId, {
      localVaultInstanceId: this.plugin.settings.localVaultInstanceId,
      localFileCount: manifest.fileCount,
      localManifestHash: manifest.manifestHash
    });
  }

  private async savePairedDevice(deviceId: string, deviceToken: string): Promise<void> {
    const settings = this.plugin.settings;
    settings.deviceId = deviceId;
    settings.deviceToken = deviceToken;
    settings.password = "";
    settings.vaultLinked = false;
    await this.plugin.saveSettings();
    new Notice("Private Sync: device paired. Choose and link a server vault.", 10000);
  }

  private async waitForPairingApproval(requestId: string, password: string): Promise<void> {
    const attempts = 150;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await sleep(2000);
      if (this.plugin.handleOfflineSyncAttempt()) continue;
      const response = await this.api.deviceRequestStatus(requestId, password);
      if (response.status === "approved") {
        await this.savePairedDevice(response.deviceId, response.deviceToken);
        return;
      }
      if (response.status !== "pending") {
        throw new Error(`Pairing request ended with status: ${response.status}.`);
      }
    }
    new Notice("Private Sync: pairing request is still pending. Try pairing again or use a recovery pairing code.", 10000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isAutoMergeCandidate(
  operation: PendingOperation,
  _record: { wasSynced: boolean } | undefined,
  file: unknown
): file is TFile {
  if (!(file instanceof TFile)) return false;
  if (operation.type !== "create" && operation.type !== "update") return false;
  if (!isAutoMergeTextFile(file)) return false;
  return true;
}

function isSyncedDeletedRecord(record: { localHash: string | null; size: number; status: string }): boolean {
  return record.status === "synced" && record.localHash === null && record.size === 0;
}

function isAutoMergeTextFile(file: TFile): boolean {
  return isTextLikePath(file.path);
}

function isTextLikePath(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return extension === "md" || extension === "markdown" || extension === "txt";
}

function mergeTextThreeWay(baseText: string, localText: string, remoteText: string): ThreeWayMergeResult | null {
  if (localText === remoteText) return { text: localText, hasConflicts: false };
  if (baseText === localText) return { text: remoteText, hasConflicts: false };
  if (baseText === remoteText) return { text: localText, hasConflicts: false };

  const baseLines = splitLines(baseText);
  const localLines = splitLines(localText);
  const remoteLines = splitLines(remoteText);
  if (baseLines.length * Math.max(localLines.length, remoteLines.length) > 1_000_000) return null;

  const localChanges = computeLineChanges(baseLines, localLines);
  const remoteChanges = computeLineChanges(baseLines, remoteLines);
  if (!localChanges || !remoteChanges) return null;

  const result: string[] = [];
  let cursor = 0;
  let localIndex = 0;
  let remoteIndex = 0;
  let hasConflicts = false;

  while (cursor < baseLines.length || localIndex < localChanges.length || remoteIndex < remoteChanges.length) {
    const local = localChanges[localIndex];
    const remote = remoteChanges[remoteIndex];
    const nextStart = Math.min(local?.baseStart ?? Number.POSITIVE_INFINITY, remote?.baseStart ?? Number.POSITIVE_INFINITY);

    if (!local && !remote) {
      result.push(...baseLines.slice(cursor));
      break;
    }

    if (cursor < nextStart) {
      result.push(...baseLines.slice(cursor, nextStart));
      cursor = nextStart;
      continue;
    }

    if (local && remote && changesOverlap(local, remote)) {
      const overlappingLocal: LineChange[] = [];
      const overlappingRemote: LineChange[] = [];
      let unionStart = Math.min(local.baseStart, remote.baseStart);
      let unionEnd = Math.max(local.baseEnd, remote.baseEnd);
      while (localIndex < localChanges.length && changeTouchesRange(localChanges[localIndex], unionStart, unionEnd)) {
        const change = localChanges[localIndex++];
        overlappingLocal.push(change);
        unionStart = Math.min(unionStart, change.baseStart);
        unionEnd = Math.max(unionEnd, change.baseEnd);
      }
      while (remoteIndex < remoteChanges.length && changeTouchesRange(remoteChanges[remoteIndex], unionStart, unionEnd)) {
        const change = remoteChanges[remoteIndex++];
        overlappingRemote.push(change);
        unionStart = Math.min(unionStart, change.baseStart);
        unionEnd = Math.max(unionEnd, change.baseEnd);
      }
      const localReplacement = applyChangesToRange(baseLines, unionStart, unionEnd, overlappingLocal);
      const remoteReplacement = applyChangesToRange(baseLines, unionStart, unionEnd, overlappingRemote);
      if (sameLines(localReplacement, remoteReplacement)) {
        result.push(...localReplacement);
      } else {
        hasConflicts = true;
        result.push("<<<<<<< local", ...localReplacement, "=======", ...remoteReplacement, ">>>>>>> remote");
      }
      cursor = unionEnd;
      continue;
    }

    if (local && (!remote || local.baseStart <= remote.baseStart)) {
      result.push(...local.replacement);
      cursor = local.baseEnd;
      localIndex += 1;
      continue;
    }

    if (remote) {
      result.push(...remote.replacement);
      cursor = remote.baseEnd;
      remoteIndex += 1;
      continue;
    }
  }

  return { text: result.join("\n"), hasConflicts };
}

function computeLineChanges(baseLines: string[], targetLines: string[]): LineChange[] | null {
  const rows = baseLines.length + 1;
  const columns = targetLines.length + 1;
  if (rows * columns > 1_000_000) return null;
  const table = Array.from({ length: rows }, () => new Uint32Array(columns));
  for (let baseIndex = baseLines.length - 1; baseIndex >= 0; baseIndex -= 1) {
    for (let targetIndex = targetLines.length - 1; targetIndex >= 0; targetIndex -= 1) {
      table[baseIndex][targetIndex] =
        baseLines[baseIndex] === targetLines[targetIndex]
          ? table[baseIndex + 1][targetIndex + 1] + 1
          : Math.max(table[baseIndex + 1][targetIndex], table[baseIndex][targetIndex + 1]);
    }
  }

  const matches: Array<{ baseIndex: number; targetIndex: number }> = [];
  let baseIndex = 0;
  let targetIndex = 0;
  while (baseIndex < baseLines.length && targetIndex < targetLines.length) {
    if (baseLines[baseIndex] === targetLines[targetIndex]) {
      matches.push({ baseIndex, targetIndex });
      baseIndex += 1;
      targetIndex += 1;
    } else if (table[baseIndex + 1][targetIndex] >= table[baseIndex][targetIndex + 1]) {
      baseIndex += 1;
    } else {
      targetIndex += 1;
    }
  }

  const changes: LineChange[] = [];
  let previousBase = 0;
  let previousTarget = 0;
  for (const match of matches) {
    if (previousBase < match.baseIndex || previousTarget < match.targetIndex) {
      changes.push({
        baseStart: previousBase,
        baseEnd: match.baseIndex,
        replacement: targetLines.slice(previousTarget, match.targetIndex)
      });
    }
    previousBase = match.baseIndex + 1;
    previousTarget = match.targetIndex + 1;
  }
  if (previousBase < baseLines.length || previousTarget < targetLines.length) {
    changes.push({
      baseStart: previousBase,
      baseEnd: baseLines.length,
      replacement: targetLines.slice(previousTarget)
    });
  }
  return changes;
}

function changesOverlap(left: LineChange, right: LineChange): boolean {
  if (left.baseStart === left.baseEnd) return left.baseStart >= right.baseStart && left.baseStart <= right.baseEnd;
  if (right.baseStart === right.baseEnd) return right.baseStart >= left.baseStart && right.baseStart <= left.baseEnd;
  return left.baseStart < right.baseEnd && right.baseStart < left.baseEnd;
}

function changeTouchesRange(change: LineChange, start: number, end: number): boolean {
  if (change.baseStart === change.baseEnd) return change.baseStart >= start && change.baseStart <= end;
  if (start === end) return start >= change.baseStart && start <= change.baseEnd;
  return change.baseStart < end && start < change.baseEnd;
}

function applyChangesToRange(baseLines: string[], start: number, end: number, changes: LineChange[]): string[] {
  const result: string[] = [];
  let cursor = start;
  for (const change of changes.sort((left, right) => left.baseStart - right.baseStart)) {
    if (cursor < change.baseStart) result.push(...baseLines.slice(cursor, change.baseStart));
    result.push(...change.replacement);
    cursor = Math.max(cursor, change.baseEnd);
  }
  if (cursor < end) result.push(...baseLines.slice(cursor, end));
  return result;
}

function sameLines(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}

function mergeServerWithUniqueLocal(serverText: string, localText: string, baseText: string | null): { text: string; appendedLineCount: number } | null {
  if (serverText === localText) return { text: serverText, appendedLineCount: 0 };
  if (!localText.trim()) return { text: serverText, appendedLineCount: 0 };
  const serverLines = splitLines(serverText);
  const localLines = splitLines(localText);
  const serverLineSet = new Set(serverLines.map((line) => line.trim()).filter(Boolean));
  if (baseText !== null) {
    const baseLineSet = new Set(splitLines(baseText).map((line) => line.trim()).filter(Boolean));
    const localLineSet = new Set(localLines.map((line) => line.trim()).filter(Boolean));
    const localRemovedBaseLineStillOnServer = Array.from(baseLineSet).some((line) => serverLineSet.has(line) && !localLineSet.has(line));
    const localHasNewLine = localLines.some((line) => {
      const normalized = line.trim();
      return normalized && !baseLineSet.has(normalized) && !serverLineSet.has(normalized);
    });
    if (localRemovedBaseLineStillOnServer && localHasNewLine) return null;
  }
  const uniqueLocalLines = localLines.filter((line) => {
    const normalized = line.trim();
    return normalized && !serverLineSet.has(normalized);
  });
  if (uniqueLocalLines.length === 0) return { text: serverText, appendedLineCount: 0 };
  const separator = serverText.endsWith("\n") || serverText.length === 0 ? "" : "\n";
  return {
    text: `${serverText}${separator}${uniqueLocalLines.join("\n")}`,
    appendedLineCount: uniqueLocalLines.length
  };
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function decodeUtf8(content: ArrayBuffer): string {
  return new TextDecoder().decode(content);
}

function encodeUtf8(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}
