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

test("local create without a base revision prefers the existing server note", () => {
  assert.equal(shouldPreferServerForCreateCollision({ type: "create", baseRevisionId: null }), true);
});

test("updates and creates with a base revision do not use server-first collision handling", () => {
  assert.equal(shouldPreferServerForCreateCollision({ type: "update", baseRevisionId: null }), false);
  assert.equal(shouldPreferServerForCreateCollision({ type: "create", baseRevisionId: 42 }), false);
});
