import { Notice, TFile, normalizePath } from "obsidian";
import { ApiClient } from "./apiClient";
import { sha256, uuid } from "./crypto";
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

  async pairDevice(recoveryPairingCode?: string): Promise<void> {
    const settings = this.plugin.settings;
    const response = await this.api.requestDevice({
      password: settings.password,
      deviceName: settings.deviceName,
      deviceType: settings.deviceType,
      recoveryPairingCode
    });
    if (response.status === "approved") {
      settings.deviceId = response.deviceId;
      settings.deviceToken = response.deviceToken;
      settings.password = "";
      await this.plugin.saveSettings();
      new Notice("Private Sync: device paired.");
    } else {
      new Notice(`Private Sync: pairing request pending (${response.requestId}).`);
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
      if (path.startsWith(".obsidian/")) continue;
      seen.add(path);
      const content = await this.plugin.app.vault.readBinary(file);
      const localHash = await sha256(content);
      const previous = index.files[path];
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
    const batchOperations = [...index.queue];
    const { batchId } = await this.api.createBatch(this.plugin.settings.vaultId, batchOperations);
    for (const operation of batchOperations) {
      if (operation.type === "delete") continue;
      const file = this.plugin.app.vault.getAbstractFileByPath(operation.path);
      if (!(file instanceof TFile)) continue;
      const record = index.files[operation.path];
      if (record) record.status = "uploading";
      await this.indexStore.save();
      await this.api.upload(this.plugin.settings.vaultId, batchId, operation, await this.plugin.app.vault.readBinary(file));
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
      if (file instanceof TFile) await this.plugin.app.vault.delete(file);
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
    const content = await this.api.download(this.plugin.settings.vaultId, change.path);
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
}
