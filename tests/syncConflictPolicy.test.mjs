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

const { canAutoResolveCreateConflict } = await import(pathToFileURL(bundledHelpers).href);
const encode = (value) => new TextEncoder().encode(value).buffer;

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("identical create without a base revision can be resolved automatically", () => {
  assert.equal(
    canAutoResolveCreateConflict({ type: "create", baseRevisionId: null }, encode("same content"), encode("same content")),
    true
  );
});

test("create without a base revision stays conflicted when content differs", () => {
  assert.equal(
    canAutoResolveCreateConflict({ type: "create", baseRevisionId: null }, encode("local"), encode("server")),
    false
  );
});

test("updates and operations with a base revision still use three-way merge", () => {
  const content = encode("same content");
  assert.equal(canAutoResolveCreateConflict({ type: "update", baseRevisionId: null }, content, content), false);
  assert.equal(canAutoResolveCreateConflict({ type: "create", baseRevisionId: 42 }, content, content), false);
});
