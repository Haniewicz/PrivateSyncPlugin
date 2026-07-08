import { Notice, TFile, normalizePath } from "obsidian";
import { ApiClient } from "./apiClient";
import { sha256, uuid } from "./crypto";
import { chunkSizeBytes, shouldAutoSync, shouldUseChunkedTransfer } from "./filePolicy";
import type { LocalIndexStore } from "./localIndex";
import type PrivateSyncPlugin from "./plugin";
import type { PendingOperation, ServerChange } from "./types";

export class SyncEngine {
  private running = false;

  constructor(
    private readonly plugin: PrivateSyncPlugin,
    private readonly indexStore: LocalIndexStore,
    private readonly api: ApiClient
  ) {}

  async pairDevice(input: { password?: string; recoveryPairingCode?: string } = {}): Promise<void> {
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
    if (this.running) return;
    this.running = true;
    try {
      await this.scanLocalChanges();
      await this.pushQueue();
      await this.pullChanges();
      this.plugin.refreshView();
    } finally {
      this.running = false;
    }
  }

  async scanLocalChanges(): Promise<void> {
    const index = this.indexStore.get();
    const seen = new Set<string>();
    const files = this.plugin.app.vault.getFiles();
    for (const file of files) {
      const path = normalizePath(file.path);
      if (path.startsWith(`${this.plugin.app.vault.configDir}/`)) continue;
      seen.add(path);
      if (!shouldAutoSync(file, this.plugin.settings)) {
        const previous = index.files[path];
        index.files[path] = {
          path,
          localHash: previous?.localHash ?? null,
          size: file.stat.size,
          mtime: file.stat.mtime,
          serverRevisionId: previous?.serverRevisionId ?? null,
          status: "ignored",
          wasSynced: previous?.wasSynced ?? false
        };
        continue;
      }
      const previous = index.files[path];
      if (previous && previous.size === file.stat.size && previous.mtime === file.stat.mtime && previous.status === "synced") {
        continue;
      }
      const content = await this.plugin.app.vault.readBinary(file);
      const localHash = await sha256(content);
      if (!previous) {
        index.files[path] = {
          path,
          localHash,
          size: file.stat.size,
          mtime: file.stat.mtime,
          serverRevisionId: null,
          status: "dirty_local",
          wasSynced: false
        };
        await this.enqueueFile(file, "create", null, localHash);
      } else if (previous.localHash !== localHash && previous.status !== "conflict" && previous.status !== "locked_by_request") {
        previous.localHash = localHash;
        previous.size = file.stat.size;
        previous.mtime = file.stat.mtime;
        previous.status = "dirty_local";
        await this.enqueueFile(file, previous.wasSynced ? "update" : "create", previous.serverRevisionId, localHash);
      }
    }

    for (const [path, record] of Object.entries(index.files)) {
      if (!seen.has(path) && record.wasSynced && record.status !== "deleted_local") {
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
    const uploadPayloads = new Map<string, ArrayBuffer>();
    const batchOperations: PendingOperation[] = [];
    for (const operation of index.queue) {
      if (operation.type === "delete") {
        batchOperations.push(operation);
        continue;
      }
      const file = this.plugin.app.vault.getAbstractFileByPath(operation.path);
      if (!(file instanceof TFile)) continue;
      const content = await this.plugin.app.vault.readBinary(file);
      const contentHash = await sha256(content);
      operation.contentHash = contentHash;
      operation.size = content.byteLength;
      const record = index.files[operation.path];
      if (record) {
        record.localHash = contentHash;
        record.size = file.stat.size;
        record.mtime = file.stat.mtime;
      }
      uploadPayloads.set(operation.clientChangeId, content);
      batchOperations.push(operation);
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
        }
      }
      await this.indexStore.removeFromQueue(batchOperations.map((operation) => operation.clientChangeId));
    } else if (result.status === "conflict") {
      for (const operation of batchOperations) {
        const record = index.files[operation.path];
        if (record) record.status = "conflict";
      }
      await this.indexStore.save();
      new Notice("Private Sync: conflict detected.");
    } else if (result.status === "waiting_for_decision") {
      for (const operation of batchOperations) {
        const record = index.files[operation.path];
        if (record) record.status = "locked_by_request";
      }
      await this.indexStore.save();
      new Notice("Private Sync: server requires a decision.");
    }
  }

  async pullChanges(): Promise<void> {
    const index = this.indexStore.get();
    const response = await this.api.getChanges(this.plugin.settings.vaultId, index.lastAppliedRevision);
    for (const change of response.changes) {
      await this.applyServerChange(change);
      index.lastAppliedRevision = Math.max(index.lastAppliedRevision, change.vaultRevision);
    }
    await this.indexStore.save();
  }

  private async applyServerChange(change: ServerChange): Promise<void> {
    const index = this.indexStore.get();
    const record = index.files[change.path];
    if (record?.status === "dirty_local" || record?.status === "pending_upload" || record?.status === "conflict") {
      record.status = "conflict";
      return;
    }
    if (change.deleted) {
      const file = this.plugin.app.vault.getAbstractFileByPath(change.path);
      if (file instanceof TFile) await this.plugin.app.fileManager.trashFile(file);
      index.files[change.path] = {
        path: change.path,
        localHash: null,
        size: 0,
        mtime: Date.now(),
        serverRevisionId: change.fileRevisionId,
        status: "synced",
        wasSynced: true
      };
      return;
    }
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

  private async enqueueFile(file: TFile, type: "create" | "update", baseRevisionId: number | null, contentHash: string): Promise<void> {
    await this.indexStore.enqueue({
      clientChangeId: uuid(),
      type,
      path: file.path,
      baseRevisionId,
      contentHash,
      size: file.stat.size,
      detectedAt: new Date().toISOString()
    });
  }

  private async writeFile(path: string, content: ArrayBuffer): Promise<void> {
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.plugin.app.vault.modifyBinary(existing, content);
      return;
    }
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) await this.plugin.app.vault.createFolder(parent).catch(() => undefined);
    await this.plugin.app.vault.createBinary(path, content);
  }

  private async savePairedDevice(deviceId: string, deviceToken: string): Promise<void> {
    const settings = this.plugin.settings;
    settings.deviceId = deviceId;
    settings.deviceToken = deviceToken;
    settings.password = "";
    await this.plugin.saveSettings();
    new Notice("Private Sync: device paired.", 8000);
  }

  private async waitForPairingApproval(requestId: string, password: string): Promise<void> {
    const attempts = 150;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await sleep(2000);
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
