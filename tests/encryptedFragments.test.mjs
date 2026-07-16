import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tempDir = await mkdtemp(path.join(tmpdir(), "private-sync-encrypted-fragments-test-"));
const bundledHelpers = path.join(tempDir, "encryptedFragments.mjs");

await build({
  entryPoints: [path.resolve("src/encryptedFragments.ts")],
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

test("findEncryptedFragments detects one and many encrypted text markers", () => {
  const first = "%%private-sync-encrypted:v1:abcDEF_123-%%";
  const second = "%%private-sync-encrypted:v1:xyz987%%";
  const text = `before ${first} middle ${second} after`;

  assert.deepEqual(helpers.findEncryptedFragments(text), [
    { marker: first, start: 7, end: 48 },
    { marker: second, start: 56, end: 92 }
  ]);
});

test("findEncryptedFragmentAtOffset returns the marker under the cursor", () => {
  const marker = "%%private-sync-encrypted:v1:abc%%";
  const text = `plain ${marker} plain`;

  assert.equal(helpers.findEncryptedFragmentAtOffset(text, 0), null);
  assert.deepEqual(helpers.findEncryptedFragmentAtOffset(text, 10), {
    marker,
    start: 6,
    end: 39
  });
});

test("replaceEncryptedFragment replaces only the selected marker", () => {
  const first = "%%private-sync-encrypted:v1:first%%";
  const second = "%%private-sync-encrypted:v1:second%%";
  const text = `${first}\nkeep\n${second}`;
  const fragment = helpers.findEncryptedFragments(text)[1];

  assert.equal(helpers.replaceEncryptedFragment(text, fragment, "plain"), `${first}\nkeep\nplain`);
});

test("replaceEncryptedFragment rejects stale fragment ranges", () => {
  const marker = "%%private-sync-encrypted:v1:first%%";
  const text = `before ${marker}`;
  const fragment = helpers.findEncryptedFragments(text)[0];

  assert.throws(
    () => helpers.replaceEncryptedFragment(`changed ${marker}`, fragment, "plain"),
    /changed before/
  );
});
