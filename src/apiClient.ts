import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import type { DeviceType, PendingOperation, ServerChange } from "./types";

type ApiRequestInit = Omit<RequestUrlParam, "url"> & { authenticated?: boolean };

export class ApiClient {
  constructor(private readonly serverUrl: string, private readonly getToken: () => string) {}

  async serverInfo(): Promise<{ protocolVersion: string; serverVersion: string; features: string[] }> {
    return this.get("/api/v1/server-info");
  }

  async login(password: string): Promise<{ ok: true; initialSetup: boolean }> {
    return this.post("/api/v1/auth/login", { password }, false);
  }

  async requestDevice(input: {
    password: string;
    deviceName: string;
    deviceType: DeviceType;
    recoveryPairingCode?: string;
  }): Promise<{ status: "approved"; deviceId: string; deviceToken: string } | { status: "pending"; requestId: string }> {
    return this.post("/api/v1/devices/request", input, false);
  }

  async getVaults(): Promise<{ vaults: Array<{ id: string; name: string; currentRevision: number }> }> {
    return this.get("/api/v1/vaults");
  }

  async getChanges(vaultId: string, since: number): Promise<{ changes: ServerChange[] }> {
    return this.get(`/api/v1/vaults/${encodeURIComponent(vaultId)}/changes?since=${since}`);
  }

  async createBatch(vaultId: string, operations: PendingOperation[]): Promise<{ batchId: string; status: string }> {
    return this.post(`/api/v1/vaults/${encodeURIComponent(vaultId)}/sync-batches`, { operations });
  }

  async upload(vaultId: string, batchId: string, operation: PendingOperation, content: ArrayBuffer): Promise<void> {
    await this.uploadChunked(vaultId, batchId, operation, content, content.byteLength || 1);
  }

  async uploadChunked(
    vaultId: string,
    batchId: string,
    operation: PendingOperation,
    content: ArrayBuffer,
    chunkSize: number
  ): Promise<void> {
    const init = await this.post<{ uploadId: string }>(
      `/api/v1/vaults/${encodeURIComponent(vaultId)}/sync-batches/${encodeURIComponent(batchId)}/chunked-upload`,
      {
        clientChangeId: operation.clientChangeId,
        contentHash: operation.contentHash,
        size: content.byteLength,
        chunkSize,
        totalChunks: Math.ceil(content.byteLength / chunkSize)
      }
    );
    for (let offset = 0, index = 0; offset < content.byteLength; offset += chunkSize, index += 1) {
      const chunk = content.slice(offset, Math.min(offset + chunkSize, content.byteLength));
      await this.request(
        `/api/v1/vaults/${encodeURIComponent(vaultId)}/sync-batches/${encodeURIComponent(batchId)}/chunked-upload/${encodeURIComponent(init.uploadId)}/chunks/${index}`,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: chunk
        }
      );
    }
    await this.post(
      `/api/v1/vaults/${encodeURIComponent(vaultId)}/sync-batches/${encodeURIComponent(batchId)}/chunked-upload/${encodeURIComponent(init.uploadId)}/finish`,
      {}
    );
  }

  async commit(vaultId: string, batchId: string): Promise<{ status: string; revision?: number; conflicts?: string[]; requestId?: string }> {
    return this.post(`/api/v1/vaults/${encodeURIComponent(vaultId)}/sync-batches/${encodeURIComponent(batchId)}/commit`, {});
  }

  async download(vaultId: string, path: string): Promise<ArrayBuffer> {
    const response = await this.request(
      `/api/v1/vaults/${encodeURIComponent(vaultId)}/files/download?path=${encodeURIComponent(path)}`
    );
    return response.arrayBuffer;
  }

  async downloadChunked(vaultId: string, path: string, size: number, chunkSize: number): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let start = 0; start < size; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, size - 1);
      const response = await this.request(
        `/api/v1/vaults/${encodeURIComponent(vaultId)}/files/download?path=${encodeURIComponent(path)}`,
        {
          headers: { range: `bytes=${start}-${end}` }
        }
      );
      const chunk = new Uint8Array(response.arrayBuffer);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged.buffer;
  }

  async devices(): Promise<{ devices: unknown[] }> {
    return this.get("/api/v1/devices");
  }

  async requests(vaultId: string): Promise<{ requests: unknown[] }> {
    return this.get(`/api/v1/vaults/${encodeURIComponent(vaultId)}/requests`);
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.request(path);
    return response.json as T;
  }

  private async post<T>(path: string, body: unknown, authenticated = true): Promise<T> {
    const response = await this.request(path, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(body),
      authenticated
    });
    return response.json as T;
  }

  private async request(path: string, init: ApiRequestInit = {}): Promise<RequestUrlResponse> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.authenticated !== false) {
      const token = this.getToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    const { authenticated, ...requestInit } = init;
    const url = `${this.serverUrl.replace(/\/$/, "")}${path}`;
    let response: RequestUrlResponse;
    try {
      response = await requestUrl({
        ...requestInit,
        url,
        headers,
        throw: false
      });
    } catch (error) {
      throw new Error(`Cannot reach Private Sync server at ${this.serverUrl}: ${formatRequestError(error)}`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(formatHttpError(response));
    }
    return response;
  }
}

function formatHttpError(response: RequestUrlResponse): string {
  const text = response.text?.trim();
  if (!text) return `Server returned HTTP ${response.status}.`;
  try {
    const body = JSON.parse(text) as { error?: string; message?: string };
    return body.error || body.message ? `Server returned HTTP ${response.status}: ${body.error ?? body.message}` : `Server returned HTTP ${response.status}.`;
  } catch {
    return `Server returned HTTP ${response.status}: ${text.slice(0, 200)}`;
  }
}

function formatRequestError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
