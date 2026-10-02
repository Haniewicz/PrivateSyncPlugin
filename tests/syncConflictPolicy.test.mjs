import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tempDir = await mkdtemp(path.join(tmpdir(), "private-sync-conflict-policy-test-"));
const bundledHelpers = path.join(tempDir, "syncConflictPolicy.mjs");

await build({
  entryPoints: [path.resolve("src/syncConflictPolicy.ts")],
  outfile: bundledHelpers,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  logLevel: "silent"
});

const { shouldPreferServerForCreateCollision } = await import(pathToFileURL(bundledHelpers).href);

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("unchanged local create without a base revision prefers the acknowledged server note", () => {
  assert.equal(
    shouldPreferServerForCreateCollision({ type: "create", baseRevisionId: null, contentHash: "uploaded" }, "uploaded"),
    true
  );
});

test("changed local creates, updates, and creates with a base revision preserve local content", () => {
  assert.equal(shouldPreferServerForCreateCollision({ type: "create", baseRevisionId: null, contentHash: "uploaded" }, "newer"), false);
  assert.equal(shouldPreferServerForCreateCollision({ type: "update", baseRevisionId: null, contentHash: "same" }, "same"), false);
  assert.equal(shouldPreferServerForCreateCollision({ type: "create", baseRevisionId: 42, contentHash: "same" }, "same"), false);
});

test("encrypted creates compare the local content with the uploaded plaintext hash", () => {
  assert.equal(
    shouldPreferServerForCreateCollision(
      { type: "create", baseRevisionId: null, contentHash: "ciphertext", plaintextHash: "plaintext" },
      "plaintext"
    ),
    true
  );
});
