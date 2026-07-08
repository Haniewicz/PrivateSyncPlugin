import { sha256, sha256Text } from "./crypto";
import { listLocalSyncFiles, readLocalBinary } from "./localFiles";
import type PrivateSyncPlugin from "./plugin";
import type { VaultManifest } from "./types";

export async function buildLocalVaultManifest(plugin: PrivateSyncPlugin): Promise<VaultManifest> {
  const entries: Array<{ path: string; contentHash: string; size: number }> = [];
  let totalSize = 0;
  for (const file of await listLocalSyncFiles(plugin)) {
    const path = file.path;
    const content = await readLocalBinary(plugin, path);
    const contentHash = await sha256(content);
    entries.push({ path, contentHash, size: file.size });
    totalSize += file.size;
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    fileCount: entries.length,
    totalSize,
    manifestHash: await sha256Text(entries.map((entry) => `${entry.path}\0${entry.contentHash}\0${entry.size}`).join("\n"))
  };
}
