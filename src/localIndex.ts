import type PrivateSyncPlugin from "./plugin";
import { DEFAULT_INDEX } from "./defaults";
import type { LocalIndex, PendingOperation } from "./types";

export class LocalIndexStore {
  private index: LocalIndex = structuredClone(DEFAULT_INDEX);

  constructor(private readonly plugin: PrivateSyncPlugin) {}

  async load(): Promise<LocalIndex> {
    const data = await this.plugin.loadData();
    this.index = {
      ...DEFAULT_INDEX,
      ...(data?.index ?? {}),
      files: data?.index?.files ?? {},
      queue: data?.index?.queue ?? []
    };
    return this.index;
  }

  get(): LocalIndex {
    return this.index;
  }

  async save(): Promise<void> {
    await this.plugin.savePluginData({ index: this.index });
  }

  async reset(): Promise<void> {
    this.index = structuredClone(DEFAULT_INDEX);
    await this.save();
  }

  async enqueue(operation: PendingOperation): Promise<void> {
    if (this.index.queue.some((queued) => queued.clientChangeId === operation.clientChangeId)) return;
    this.index.queue = this.index.queue.filter((queued) => queued.path !== operation.path);
    this.index.queue.push(operation);
    const record = this.index.files[operation.path];
    if (record) record.status = operation.type === "delete" ? "deleted_local" : "pending_upload";
    await this.save();
  }

  async removeFromQueue(ids: string[]): Promise<void> {
    const set = new Set(ids);
    this.index.queue = this.index.queue.filter((operation) => !set.has(operation.clientChangeId));
    await this.save();
  }

  async removePathFromQueue(path: string): Promise<void> {
    this.index.queue = this.index.queue.filter((operation) => operation.path !== path);
    await this.save();
  }
}
