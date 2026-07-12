import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tempDir = await mkdtemp(path.join(tmpdir(), "private-sync-crypto-test-"));
const bundledCrypto = path.join(tempDir, "crypto.mjs");

await build({
  entryPoints: [path.resolve("src/crypto.ts")],
  outfile: bundledCrypto,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  logLevel: "silent"
});

const cryptoModule = await import(pathToFileURL(bundledCrypto).href);

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("encryptBytes and decryptBytes round-trip binary content", async () => {
  const original = new Uint8Array([0, 1, 2, 3, 252, 253, 254, 255]).buffer;
  const encrypted = await cryptoModule.encryptBytes(original, "correct horse battery staple");

  assert.notDeepEqual(new Uint8Array(encrypted), new Uint8Array(original));

  const decrypted = await cryptoModule.decryptBytes(encrypted, "correct horse battery staple");
  assert.deepEqual([...new Uint8Array(decrypted)], [...new Uint8Array(original)]);
});

test("decryptBytes rejects an incorrect passphrase", async () => {
  const original = new TextEncoder().encode("secret note").buffer;
  const encrypted = await cryptoModule.encryptBytes(original, "right passphrase");

  await assert.rejects(() => cryptoModule.decryptBytes(encrypted, "wrong passphrase"));
});

test("text fragment encryption round-trips multiline text", async () => {
  const text = "first line\nsecond line\nthird line";
  const marker = await cryptoModule.encryptTextFragment(text, "fragment passphrase");

  assert.match(marker, /^%%private-sync-encrypted:v1:[A-Za-z0-9_-]+%%$/);

  const decrypted = await cryptoModule.decryptTextFragment(marker, "fragment passphrase");
  assert.equal(decrypted, text);
});

test("isEncryptedPayload only accepts the Private Sync envelope prefix", async () => {
  const marker = await cryptoModule.encryptTextFragment("hello", "fragment passphrase");
  const payload = marker.slice(2, -2);

  assert.equal(cryptoModule.isEncryptedPayload(payload), true);
  assert.equal(cryptoModule.isEncryptedPayload(marker), false);
  assert.equal(cryptoModule.isEncryptedPayload("private-sync-encrypted:v2:abc"), false);
  assert.equal(cryptoModule.isEncryptedPayload("not encrypted"), false);
});
