import type { LocalIndex, PluginSettings } from "./types";

export const DEFAULT_SETTINGS: PluginSettings = {
  serverUrl: "http://127.0.0.1:8787",
  deviceName: "Obsidian device",
  deviceType: "desktop",
  password: "",
  deviceToken: "",
  deviceId: "",
  vaultId: "default",
  autoSync: true,
  syncAttachments: true,
  maxAutoSyncFileSizeMb: 100,
  largeFileChunkSizeMb: 5,
  largeFileThresholdMb: 10
};

export const DEFAULT_INDEX: LocalIndex = {
  lastAppliedRevision: 0,
  files: {},
  queue: []
};
