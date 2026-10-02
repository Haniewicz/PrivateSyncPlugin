import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tempDir = await mkdtemp(path.join(tmpdir(), "private-sync-recovery-test-"));
const bundlePath = path.join(tempDir, "sync-recovery.mjs");

await build({
  stdin: {
    contents: [
      'export { SyncEngine } from "./src/syncEngine";',
      'export { LocalIndexStore } from "./src/localIndex";',
      'export { DEFAULT_SETTINGS } from "./src/defaults";',
      'export { TFile } from "obsidian";'
    ].join("\n"),
    resolveDir: process.cwd()
  },
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  plugins: [
    {
      name: "obsidian-test-double",
      setup(builder) {
        builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "obsidian-test" }));
        builder.onLoad({ filter: /.*/, namespace: "obsidian-test" }, () => ({
          contents: [
            "export class TFile {}",
            "export class TFolder {}",
            "export class Notice { constructor() {} }",
            "export const normalizePath = (value) => value;",
            'export const requestUrl = () => { throw new Error("Unexpected HTTP request in test."); };'
          ].join("\n")
        }));
        builder.onResolve({ filter: /vaultConnectionModal$/ }, () => ({ path: "vault-modal", namespace: "modal-test" }));
        builder.onLoad({ filter: /.*/, namespace: "modal-test" }, () => ({ contents: "export const openVaultConnectionModal = async () => null;" }));
      }
    }
  ],
  logLevel: "silent"
});

const { SyncEngine, LocalIndexStore, DEFAULT_SETTINGS, TFile } = await import(pathToFileURL(bundlePath).href);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("a lost commit response is reconciled before a later local edit is uploaded", async () => {
  const fixture = createFixture();
  fixture.write("note.md", "A");
  await fixture.engine.syncNow();

  fixture.write("note.md", "AB");
  fixture.api.dropNextCommitResponse = true;
  await assert.rejects(fixture.engine.syncNow(), /lost commit response/);

  fixture.write("note.md", "ABC");
  await fixture.engine.syncNow();

  assert.equal(fixture.api.serverText("note.md"), "ABC");
  assert.equal(fixture.store.get().files["note.md"].status, "synced");
  assert.deepEqual(fixture.api.commitCalls, ["batch-1", "batch-2", "batch-2", "batch-3"]);
});

test("a new note keeps text added after a lost commit response", async () => {
  const fixture = createFixture();
  fixture.write("new.md", "AB");
  fixture.api.dropNextCommitResponse = true;
  await assert.rejects(fixture.engine.syncNow(), /lost commit response/);

  fixture.write("new.md", "ABC");
  const restarted = await fixture.restart();
  await restarted.engine.syncNow();

  assert.equal(fixture.read("new.md"), "ABC");
  assert.equal(fixture.api.serverText("new.md"), "ABC");
  assert.equal(restarted.store.get().files["new.md"].status, "synced");
  assert.deepEqual(fixture.api.commitCalls, ["batch-1", "batch-1", "batch-2"]);
});

test("only operations named by the server are marked as conflicts", async () => {
  const fixture = createFixture();
  const noteOperation = operation("note.md", "note-change");
  const attachmentOperation = operation("image.bin", "image-change");
  fixture.store.get().queue = [noteOperation, attachmentOperation];
  fixture.store.get().files = {
    "note.md": record("note.md"),
    "image.bin": record("image.bin")
  };
  fixture.api.pendingConflicts = [{
    id: "conflict-1",
    filePath: "note.md",
    incomingClientChangeId: "note-change"
  }];

  const shouldContinue = await fixture.engine.handleCommitResult(
    { status: "conflict", conflicts: ["conflict-1"] },
    [noteOperation, attachmentOperation]
  );

  assert.equal(shouldContinue, true);
  assert.equal(fixture.store.get().files["note.md"].status, "conflict");
  assert.equal(fixture.store.get().files["image.bin"].status, "pending_upload");
});

function createFixture() {
  const files = new Map();
  let stored = {};
  let mtime = 1;
  const plugin = {
    settings: {
      ...DEFAULT_SETTINGS,
      serverUrl: "https://sync.test",
      deviceToken: "token",
      deviceId: "device-1",
      vaultId: "vault-1",
      vaultLinked: true,
      syncObsidianSettings: false,
      syncCommunityPlugins: false
    },
    app: {
      vault: {
        configDir: ".obsidian",
        getFiles: () => [...files.values()],
        getAbstractFileByPath: (filePath) => files.get(filePath) ?? null,
        readBinary: async (file) => file.content,
        modifyBinary: async (file, content) => updateFile(file.path, content),
        adapter: {
          exists: async () => false,
          stat: async () => null
        }
      }
    },
    loadData: async () => stored,
    savePluginData: async (partial) => { stored = { ...stored, ...structuredClone(partial) }; },
    recordSyncEvent: async () => undefined,
    recordSyncState: async () => undefined,
    refreshView: () => undefined,
    showAggregatedNotice: () => undefined,
    handleOfflineSyncAttempt: () => false,
    isEncryptionUnlocked: () => true,
    ensureEncryptionReadyForUpload: async () => null,
    ensureEncryptionReadyForDownload: async () => undefined,
    requireEncryptionPassphrase: () => "test"
  };
  const api = new FakeApi();
  const store = new LocalIndexStore(plugin);
  const engine = new SyncEngine(plugin, store, api);

  function updateFile(filePath, content) {
    const file = files.get(filePath) ?? Object.assign(new TFile(), { path: filePath });
    file.content = content.slice(0);
    file.stat = { size: content.byteLength, mtime: ++mtime };
    files.set(filePath, file);
  }

  return {
    api,
    engine,
    store,
    async restart() {
      const restartedStore = new LocalIndexStore(plugin);
      await restartedStore.load();
      return { store: restartedStore, engine: new SyncEngine(plugin, restartedStore, api) };
    },
    write(filePath, text) { updateFile(filePath, encoder.encode(text).buffer); },
    read(filePath) { return decoder.decode(files.get(filePath).content); }
  };
}

class FakeApi {
  batches = new Map();
  current = new Map();
  historyByPath = new Map();
  commitCalls = [];
  pendingConflicts = [];
  dropNextCommitResponse = false;
  nextBatch = 1;
  nextRevision = 1;

  async createBatch(_vaultId, operations) {
    const batchId = `batch-${this.nextBatch++}`;
    this.batches.set(batchId, { operations: structuredClone(operations), uploads: new Map(), result: null });
    return { batchId, status: "created" };
  }

  async upload(_vaultId, batchId, operation, content) {
    this.batches.get(batchId).uploads.set(operation.clientChangeId, content.slice(0));
  }

  async commit(_vaultId, batchId) {
    this.commitCalls.push(batchId);
    const batch = this.batches.get(batchId);
    if (batch.result) return batch.result;
    const fileRevisions = [];
    for (const operation of batch.operations) {
      const current = this.current.get(operation.path);
      if ((current?.id ?? null) !== operation.baseRevisionId) {
        throw new Error(`Unexpected conflict for ${operation.path}`);
      }
      const content = batch.uploads.get(operation.clientChangeId);
      const revision = {
        id: this.nextRevision++,
        vaultRevision: this.nextRevision,
        contentHash: operation.contentHash ?? null,
        size: content?.byteLength ?? 0,
        deleted: operation.type === "delete" ? 1 : 0,
        encrypted: 0,
        deviceId: "device-1",
        createdAt: new Date().toISOString(),
        content
      };
      this.current.set(operation.path, revision);
      this.historyByPath.set(operation.path, [revision, ...(this.historyByPath.get(operation.path) ?? [])]);
      fileRevisions.push({ path: operation.path, fileRevisionId: revision.id });
    }
    batch.result = { status: "committed", revision: this.nextRevision, fileRevisions };
    if (this.dropNextCommitResponse) {
      this.dropNextCommitResponse = false;
      throw new Error("lost commit response");
    }
    return batch.result;
  }

  async getChanges() { return { changes: [] }; }
  async conflicts() { return { conflicts: this.pendingConflicts }; }
  async history(_vaultId, filePath) { return { history: this.historyByPath.get(filePath) ?? [] }; }
  async recordSyncState() { return { ok: true, revision: this.nextRevision }; }
  serverText(filePath) { return decoder.decode(this.current.get(filePath).content); }
}

function operation(filePath, clientChangeId) {
  return {
    clientChangeId,
    batchId: "failed-batch",
    type: "update",
    path: filePath,
    baseRevisionId: 1,
    contentHash: `${clientChangeId}-hash`,
    size: 1,
    detectedAt: new Date().toISOString()
  };
}

function record(filePath) {
  return {
    path: filePath,
    localHash: "hash",
    size: 1,
    mtime: 1,
    serverRevisionId: 1,
    status: "uploaded_waiting_ack",
    wasSynced: true
  };
}
