import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tempDir = await mkdtemp(path.join(tmpdir(), "private-sync-note-encryption-test-"));
const bundledHelpers = path.join(tempDir, "noteEncryption.mjs");

await build({
  entryPoints: [path.resolve("src/noteEncryption.ts")],
  outfile: bundledHelpers,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  logLevel: "silent"
});

const helpers = await import(pathToFileURL(bundledHelpers).href);

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("encryptNoteBodyText preserves frontmatter and decrypts the body", async () => {
  const note = "---\ntags:\n  - private\n---\nSecret body\nsecond line";
  const encrypted = await helpers.encryptNoteBodyText(note, "note passphrase");

  assert.match(encrypted, /^---\ntags:\n  - private\n---\n%%private-sync-encrypted:v1:[A-Za-z0-9_-]+%%$/);
  assert.equal(helpers.isEncryptedNoteBody(encrypted), true);

  const decrypted = await helpers.decryptNoteBodyText(encrypted, "note passphrase");
  assert.equal(decrypted, note);
});

test("auto-encrypt property can be added, detected, and removed", () => {
  const note = "---\ntags: test\n---\nBody";
  const enabled = helpers.setAutoEncryptProperty(note, true);

  assert.equal(helpers.hasAutoEncryptProperty(enabled), true);
  assert.match(enabled, /^---\ntags: test\nprivate-sync-encrypt: true\n---\nBody$/);

  const disabled = helpers.setAutoEncryptProperty(enabled, false);
  assert.equal(helpers.hasAutoEncryptProperty(disabled), false);
  assert.equal(disabled, "---\ntags: test\n---\nBody");
});

test("auto-encrypt property is inserted when a note has no frontmatter", () => {
  const enabled = helpers.setAutoEncryptProperty("Body", true);

  assert.equal(helpers.hasAutoEncryptProperty(enabled), true);
  assert.equal(enabled, "---\nprivate-sync-encrypt: true\n---\n\nBody");
});
