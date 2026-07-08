export type DeviceType = "desktop" | "mobile" | "tablet" | "unknown";

export type LocalFileStatus =
  | "synced"
  | "dirty_local"
  | "pending_upload"
  | "uploading"
  | "uploaded_waiting_ack"
  | "pending_download"
  | "conflict"
  | "locked_by_request"
  | "deleted_local"
  | "ignored"
  | "failed";

export type OperationType = "create" | "update" | "delete" | "rename" | "move";

export type LocalFileRecord = {
  path: string;
  localHash: string | null;
  size: number;
  mtime: number;
  serverRevisionId: number | null;
  status: LocalFileStatus;
  wasSynced: boolean;
};

export type PendingOperation = {
  clientChangeId: string;
  type: OperationType;
  path: string;
  baseRevisionId: number | null;
  contentHash?: string;
  size?: number;
  detectedAt: string;
};

export type LocalIndex = {
  lastAppliedRevision: number;
  files: Record<string, LocalFileRecord>;
  queue: PendingOperation[];
};

export type SyncEventType = "auto_merge" | "conflict" | "manual_resolution" | "offline" | "error" | "vault_connection";

export type SyncEvent = {
  timestamp: string;
  type: SyncEventType;
  path?: string;
  message: string;
  details?: Record<string, unknown>;
};

export type PluginSettings = {
  serverUrl: string;
  deviceName: string;
  deviceType: DeviceType;
  password: string;
  deviceToken: string;
  deviceId: string;
  localVaultInstanceId: string;
  vaultId: string;
  vaultLinked: boolean;
  autoSync: boolean;
  syncAttachments: boolean;
  syncObsidianSettings: boolean;
  syncCommunityPlugins: boolean;
  replaceRemoteCommunityPluginsWithLocal: boolean;
  maxAutoSyncFileSizeMb: number;
  largeFileChunkSizeMb: number;
  largeFileThresholdMb: number;
};

export type ServerVault = {
  id: string;
  name: string;
  currentRevision: number;
};

export type VaultManifest = {
  fileCount: number;
  totalSize: number;
  manifestHash: string;
};

export type VaultRiskLevel = "empty" | "high" | "medium" | "very_low";

export type VaultConnectionAssessment = {
  remoteFileCount: number;
  remoteRevision: number;
  remoteManifestHash: string;
  previousConnection: {
    localVaultInstanceId: string;
    lastSyncedAt: string;
    lastSeenRevision: number;
    lastManifestHash: string;
  } | null;
  riskLevel: VaultRiskLevel;
  reasons: string[];
};

export type ServerChange = {
  fileRevisionId: number;
  vaultRevision: number;
  path: string;
  contentHash: string | null;
  size: number;
  deleted: number;
  encrypted: number;
  deviceId?: string;
  createdAt: string;
};

export type DevicePairingRequestPayload = {
  deviceName: string;
  deviceType: DeviceType;
  requestedAt?: string;
  ip?: string;
};

export type ServerRequest = {
  id: string;
  type: "device_pairing" | string;
  status: "pending" | "approved" | "rejected" | "resolved" | "expired" | string;
  payload_json?: string;
  payloadJson?: string;
  decision_json?: string | null;
  decisionJson?: string | null;
  created_by_device_id?: string | null;
  createdByDeviceId?: string | null;
  created_at?: string;
  createdAt?: string;
};

export type RemoteDevice = {
  id: string;
  name: string;
  type: DeviceType;
  trusted: number;
  revoked_at: string | null;
  last_seen_at: string | null;
  created_at: string;
};

export type ServerConflict = {
  id: string;
  filePath: string;
  baseRevisionId: number | null;
  serverRevisionId: number | null;
  incomingBatchId: string;
  incomingClientChangeId: string;
  deviceId: string;
  deviceName: string | null;
  deviceType: DeviceType | null;
  status: string;
  createdAt: string;
};

export type FileHistoryEntry = {
  id: number;
  vaultRevision: number;
  contentHash: string | null;
  size: number;
  deleted: number;
  encrypted: number;
  deviceId: string;
  createdAt: string;
};
