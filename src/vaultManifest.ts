import { normalizePath, TFile } from "obsidian";
import { sha256, sha256Text } from "./crypto";
import { shouldAutoSync } from "./filePolicy";
import type PrivateSyncPlugin from "./plugin";
import type { VaultManifest } from "./types";

export async function buildLocalVaultManifest(plugin: PrivateSyncPlugin): Promise<VaultManifest> {
  const entries: Array<{ path: string; contentHash: string; size: number }> = [];
  let totalSize = 0;
  for (const file of plugin.app.vault.getFiles()) {
    if (!(file instanceof TFile)) continue;
    const path = normalizePath(file.path);
    if (path.startsWith(`${plugin.app.vault.configDir}/`)) continue;
    if (!shouldAutoSync(file, plugin.settings)) continue;
    const content = await plugin.app.vault.readBinary(file);
    const contentHash = await sha256(content);
    entries.push({ path, contentHash, size: file.stat.size });
    totalSize += file.stat.size;
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    fileCount: entries.length,
    totalSize,
    manifestHash: await sha256Text(entries.map((entry) => `${entry.path}\0${entry.contentHash}\0${entry.size}`).join("\n"))
  };
}
