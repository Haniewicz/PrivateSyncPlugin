import type { LocalIndex, PluginSettings } from "./types";
import { uuid } from "./crypto";

export const DEFAULT_SETTINGS: PluginSettings = {
  serverUrl: "http://127.0.0.1:8787",
  deviceName: "Obsidian device",
  deviceType: "desktop",
  password: "",
  deviceToken: "",
  deviceId: "",
  localVaultInstanceId: uuid(),
  vaultId: "default",
  vaultLinked: false,
  autoSync: true,
  syncAttachments: true,
  syncObsidianSettings: false,
  syncCommunityPlugins: false,
  replaceRemoteCommunityPluginsWithLocal: false,
  maxAutoSyncFileSizeMb: 100,
  largeFileChunkSizeMb: 5,
  largeFileThresholdMb: 10
};

export const DEFAULT_INDEX: LocalIndex = {
  lastAppliedRevision: 0,
  files: {},
  queue: []
};
