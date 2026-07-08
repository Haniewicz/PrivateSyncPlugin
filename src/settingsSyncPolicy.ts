import { normalizePath, type TFile } from "obsidian";
import type { PluginSettings } from "./types";

const CORE_SETTING_FILES = new Set([
  "app.json",
  "appearance.json",
  "backlink.json",
  "canvas.json",
  "command-palette.json",
  "core-plugins.json",
  "core-plugins-migration.json",
  "daily-notes.json",
  "file-recovery.json",
  "graph.json",
  "hotkeys.json",
  "note-composer.json",
  "page-preview.json",
  "random-note.json",
  "slash-command.json",
  "switcher.json",
  "templates.json",
  "zk-prefixer.json"
]);

const EXCLUDED_CONFIG_PREFIXES = ["workspace", "workspaces"];

export function shouldSyncPath(path: string, settings: PluginSettings, configDir: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedConfigDir = normalizePath(configDir);
  if (!normalizedPath.startsWith(`${normalizedConfigDir}/`)) return true;
  if (!settings.syncObsidianSettings) return false;

  const relativePath = normalizedPath.slice(normalizedConfigDir.length + 1);
  const pluginId = communityPluginIdFromRelativePath(relativePath);
  if (pluginId) return settings.syncCommunityPlugins;
  if (relativePath.includes("/")) return false;
  if (EXCLUDED_CONFIG_PREFIXES.some((prefix) => relativePath === `${prefix}.json` || relativePath.startsWith(`${prefix}-`))) return false;
  return CORE_SETTING_FILES.has(relativePath);
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
