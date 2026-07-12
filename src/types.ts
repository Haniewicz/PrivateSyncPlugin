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
  encrypted?: boolean;
  encryptedFileKey?: string | null;
  encryptionKeyId?: string | null;
  plaintextHash?: string;
  plaintextSize?: number;
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
  vaultName: string;
  vaultLinked: boolean;
  autoSync: boolean;
  syncAttachments: boolean;
  syncObsidianSettings: boolean;
  syncCommunityPlugins: boolean;
  maxAutoSyncFileSizeMb: number;
  largeFileChunkSizeMb: number;
  largeFileThresholdMb: number;
  encryptionEnabled: boolean;
  encryptionKeyCheck: string;
  encryptionKeyId: string;
  rememberEncryptionPassphrase: boolean;
};

export type ServerVault = {
  id: string;
  name: string;
  currentRevision: number;
  encryptionKeyId?: string | null;
  encryptionKeyCheck?: string | null;
};

export type CommunityPluginSetting = {
  relativePath: string;
  contentBase64: string;
  contentHash: string;
  size: number;
  sourceDeviceId?: string | null;
  updatedAt?: string;
};

export type CommunityPluginCatalogEntry = {
  id: string;
  name?: string | null;
  version?: string | null;
  author?: string | null;
  description?: string | null;
  sourceDeviceId?: string | null;
  firstSeenAt?: string;
  updatedAt?: string;
  settings: CommunityPluginSetting[];
};

export type VaultEncryptionKey = {
  id: string;
  keyCheck: string;
  active: number | boolean;
  createdAt: string;
  retiredAt?: string | null;
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
  plaintextHash?: string | null;
  plaintextSize?: number | null;
  deleted: number;
  encrypted: number;
  encryptionKeyId?: string | null;
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
  type: "device_pairing" | (string & {});
  status: "pending" | "approved" | "rejected" | "resolved" | "expired" | (string & {});
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
  vaultId: string | null;
  vaultName: string | null;
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
  plaintextHash?: string | null;
  plaintextSize?: number | null;
  deleted: number;
  encrypted: number;
  encryptionKeyId?: string | null;
  deviceId: string;
  createdAt: string;
};

export type StorageCleanupTarget = "stale_staging" | "npm_cache";

export type ServerSizeInfo = {
  bytes: number;
  diskBytes: number;
};

export type ServerStorageUsage = {
  generatedAt: string;
  totals: ServerSizeInfo & {
    dataDir: string;
    blobs: ServerSizeInfo;
    staging: ServerSizeInfo & {
      directories: number;
      files: number;
      staleDirectories: number;
    };
    database: ServerSizeInfo;
    npmCache: ServerSizeInfo & {
      exists: boolean;
    };
  };
  vaults: Array<{
    id: string;
    name: string;
    currentRevision: number;
    revisions: number;
    filesEver: number;
    liveFiles: number;
    deletedFiles: number;
    historyBytes: number;
    liveBytes: number;
    uniqueBlobBytes: number;
  }>;
  cleanup: {
    safeTargets: Array<{
      target: StorageCleanupTarget;
      label: string;
      description: string;
      bytes: number;
      count: number;
      available: boolean;
    }>;
  };
};

export type ServerStorageCleanupResult = {
  ok: true;
  cleaned: Array<{
    target: StorageCleanupTarget;
    removedBytes: number;
    removedCount: number;
  }>;
  usage: ServerStorageUsage;
};
