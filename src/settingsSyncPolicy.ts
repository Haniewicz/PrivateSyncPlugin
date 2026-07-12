import { normalizePath, type TFile } from "obsidian";
import type { PluginSettings } from "./types";

const NOTE_CREATOR_SETTING_FILES = new Set(["daily-notes.json", "templates.json", "unique-note-creator.json", "zk-prefixer.json"]);

export function shouldSyncPath(path: string, settings: PluginSettings, configDir: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedConfigDir = normalizePath(configDir);
  if (!normalizedPath.startsWith(`${normalizedConfigDir}/`)) return true;
  if (!settings.syncObsidianSettings) return false;

  const relativePath = normalizedPath.slice(normalizedConfigDir.length + 1);
  const pluginId = communityPluginIdFromRelativePath(relativePath);
  if (pluginId) return false;
  if (relativePath.includes("/")) return false;
  return NOTE_CREATOR_SETTING_FILES.has(relativePath);
}

export function shouldSyncFile(file: TFile, settings: PluginSettings, configDir: string): boolean {
  return shouldSyncPath(file.path, settings, configDir);
}

export function getCommunityPluginId(path: string, configDir: string): string | null {
  const normalizedPath = normalizePath(path);
  const normalizedConfigDir = normalizePath(configDir);
  if (!normalizedPath.startsWith(`${normalizedConfigDir}/`)) return null;
  const relativePath = normalizedPath.slice(normalizedConfigDir.length + 1);
  return communityPluginIdFromRelativePath(relativePath);
}

export function collectCommunityPluginIds(paths: Iterable<string>, configDir: string): Set<string> {
  const ids = new Set<string>();
  for (const path of paths) {
    const pluginId = getCommunityPluginId(path, configDir);
    if (pluginId) ids.add(pluginId);
  }
  return ids;
}

function communityPluginIdFromRelativePath(relativePath: string): string | null {
  const parts = relativePath.split("/");
  if (parts[0] !== "plugins" || !parts[1]) return null;
  return parts[1];
}
