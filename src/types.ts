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

export type PluginSettings = {
  serverUrl: string;
  deviceName: string;
  deviceType: DeviceType;
  password: string;
  deviceToken: string;
  deviceId: string;
  vaultId: string;
  autoSync: boolean;
};

export type ServerChange = {
  fileRevisionId: number;
  vaultRevision: number;
  path: string;
  contentHash: string | null;
  size: number;
  deleted: number;
  encrypted: number;
  createdAt: string;
};
