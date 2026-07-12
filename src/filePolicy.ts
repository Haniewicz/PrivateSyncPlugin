import type { TFile } from "obsidian";
import type { PluginSettings } from "./types";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "txt", "canvas", "json"]);

export function isTextLikePath(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return MARKDOWN_EXTENSIONS.has(extension);
}

export function isTextLikeFile(file: TFile): boolean {
  return isTextLikePath(file.path);
}

export function shouldAutoSyncPath(path: string, size: number, settings: PluginSettings): boolean {
  if (!settings.syncAttachments && !isTextLikePath(path)) return false;
  return size <= mb(settings.maxAutoSyncFileSizeMb);
}

export function shouldAutoSync(file: TFile, settings: PluginSettings): boolean {
  return shouldAutoSyncPath(file.path, file.stat.size, settings);
}

export function shouldUseChunkedTransfer(size: number, settings: PluginSettings): boolean {
  return size >= mb(settings.largeFileThresholdMb);
}

export function chunkSizeBytes(settings: PluginSettings): number {
  return Math.max(256 * 1024, mb(settings.largeFileChunkSizeMb));
}

export function mb(value: number): number {
  return Math.max(0, value) * 1024 * 1024;
}
