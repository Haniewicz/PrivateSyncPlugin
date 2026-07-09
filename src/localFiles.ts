import { normalizePath, TFile, TFolder } from "obsidian";
import { shouldAutoSyncPath } from "./filePolicy";
import type PrivateSyncPlugin from "./plugin";
import { shouldSyncPath } from "./settingsSyncPolicy";

export type LocalSyncFile = {
  path: string;
  size: number;
  mtime: number;
  file: TFile | null;
};

export async function listLocalSyncFiles(plugin: PrivateSyncPlugin): Promise<LocalSyncFile[]> {
  const files = new Map<string, LocalSyncFile>();
  for (const file of plugin.app.vault.getFiles()) {
    const path = normalizePath(file.path);
    files.set(path, {
      path,
      size: file.stat.size,
      mtime: file.stat.mtime,
      file
    });
  }

  if (plugin.settings.syncObsidianSettings) {
    for (const configFile of await listConfigFiles(plugin)) {
      files.set(configFile.path, configFile);
    }
  }

  return [...files.values()]
    .filter((file) => shouldSyncPath(file.path, plugin.settings, plugin.app.vault.configDir))
    .filter((file) => shouldAutoSyncPath(file.path, file.size, plugin.settings));
}

export async function readLocalBinary(plugin: PrivateSyncPlugin, path: string): Promise<ArrayBuffer> {
  const normalizedPath = normalizePath(path);
  const file = plugin.app.vault.getAbstractFileByPath(normalizedPath);
  if (file instanceof TFile) return plugin.app.vault.readBinary(file);
  return plugin.app.vault.adapter.readBinary(normalizedPath);
}

export async function writeLocalBinary(plugin: PrivateSyncPlugin, path: string, content: ArrayBuffer): Promise<void> {
  const normalizedPath = normalizePath(path);
  const existing = plugin.app.vault.getAbstractFileByPath(normalizedPath);
  if (existing instanceof TFile) {
    await plugin.app.vault.modifyBinary(existing, content);
    return;
  }
  const parent = normalizedPath.split("/").slice(0, -1).join("/");
  if (isConfigPath(plugin, normalizedPath)) {
    if (parent) await ensureAdapterFolder(plugin, parent);
    await plugin.app.vault.adapter.writeBinary(normalizedPath, content);
    return;
  }
  if (parent) await ensureVaultFolder(plugin, parent);
  await plugin.app.vault.createBinary(normalizedPath, content);
}

export async function trashLocalPath(plugin: PrivateSyncPlugin, path: string): Promise<void> {
  const normalizedPath = normalizePath(path);
  const file = plugin.app.vault.getAbstractFileByPath(normalizedPath);
  if (file instanceof TFile) {
    await plugin.app.fileManager.trashFile(file);
    return;
  }
  if (await plugin.app.vault.adapter.exists(normalizedPath)) {
    await plugin.app.vault.adapter.trashLocal(normalizedPath);
  }
}

export async function getLocalFileStat(plugin: PrivateSyncPlugin, path: string): Promise<{ size: number; mtime: number } | null> {
  const normalizedPath = normalizePath(path);
  const file = plugin.app.vault.getAbstractFileByPath(normalizedPath);
  if (file instanceof TFile) return { size: file.stat.size, mtime: file.stat.mtime };
  const stat = await plugin.app.vault.adapter.stat(normalizedPath);
  if (!stat || stat.type !== "file") return null;
  return { size: stat.size, mtime: stat.mtime };
}

export async function listLocalCommunityPluginIds(plugin: PrivateSyncPlugin): Promise<Set<string>> {
  const pluginsPath = normalizePath(`${plugin.app.vault.configDir}/plugins`);
  const ids = new Set<string>();
  if (!(await plugin.app.vault.adapter.exists(pluginsPath))) return ids;
  const listed = await plugin.app.vault.adapter.list(pluginsPath);
  for (const folder of listed.folders) {
    const parts = normalizePath(folder).split("/");
    const pluginId = parts[parts.length - 1];
    if (pluginId) ids.add(pluginId);
  }
  return ids;
}

async function listConfigFiles(plugin: PrivateSyncPlugin): Promise<LocalSyncFile[]> {
  const configDir = normalizePath(plugin.app.vault.configDir);
  if (!(await plugin.app.vault.adapter.exists(configDir))) return [];
  const files: LocalSyncFile[] = [];
  const visit = async (folder: string): Promise<void> => {
    const listed = await plugin.app.vault.adapter.list(folder);
    for (const filePath of listed.files) {
      const normalizedPath = normalizePath(filePath);
      if (!shouldSyncPath(normalizedPath, plugin.settings, configDir)) continue;
      const stat = await plugin.app.vault.adapter.stat(normalizedPath);
      if (!stat || stat.type !== "file") continue;
      const abstractFile = plugin.app.vault.getAbstractFileByPath(normalizedPath);
      files.push({
        path: normalizedPath,
        size: stat.size,
        mtime: stat.mtime,
        file: abstractFile instanceof TFile ? abstractFile : null
      });
    }
    for (const folderPath of listed.folders) {
      const normalizedPath = normalizePath(folderPath);
      if (!shouldExploreConfigFolder(normalizedPath, configDir, plugin.settings.syncCommunityPlugins)) continue;
      await visit(normalizedPath);
    }
  };
  await visit(configDir);
  return files;
}

async function ensureAdapterFolder(plugin: PrivateSyncPlugin, folder: string): Promise<void> {
  const parts = normalizePath(folder).split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await plugin.app.vault.adapter.exists(current))) {
      await plugin.app.vault.adapter.mkdir(current);
    }
  }
}

async function ensureVaultFolder(plugin: PrivateSyncPlugin, folder: string): Promise<void> {
  const parts = normalizePath(folder).split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = plugin.app.vault.getAbstractFileByPath(current);
    if (existing instanceof TFolder) continue;
    if (existing) throw new Error(`Cannot create folder ${current}: a file already exists at that path.`);
    await plugin.app.vault.createFolder(current);
  }
}

function isConfigPath(plugin: PrivateSyncPlugin, path: string): boolean {
  return normalizePath(path).startsWith(`${normalizePath(plugin.app.vault.configDir)}/`);
}

function shouldExploreConfigFolder(path: string, configDir: string, syncCommunityPlugins: boolean): boolean {
  const relativePath = path.slice(configDir.length + 1);
  if (!relativePath) return true;
  if (relativePath === "plugins") return syncCommunityPlugins;
  if (relativePath.startsWith("plugins/")) return syncCommunityPlugins;
  return false;
}
