import type { DeviceType, PendingOperation, ServerChange } from "./types";

export class ApiClient {
  constructor(private readonly serverUrl: string, private readonly getToken: () => string) {}

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
    const form = new FormData();
    form.append("clientChangeId", operation.clientChangeId);
    form.append("contentHash", operation.contentHash ?? "");
    form.append("file", new Blob([content]), operation.path);
    await this.request(`/api/v1/vaults/${encodeURIComponent(vaultId)}/sync-batches/${encodeURIComponent(batchId)}/upload`, {
      method: "POST",
      body: form
    });
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
    return response.arrayBuffer();
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
      const chunk = new Uint8Array(await response.arrayBuffer());
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

  private get<T>(path: string): Promise<T> {
    return this.request(path).then((response) => response.json() as Promise<T>);
  }

  private post<T>(path: string, body: unknown, authenticated = true): Promise<T> {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      authenticated
    }).then((response) => response.json() as Promise<T>);
  }

  private async request(path: string, init: RequestInit & { authenticated?: boolean } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.authenticated !== false) {
      const token = this.getToken();
      if (token) headers.set("authorization", `Bearer ${token}`);
    }
    const response = await fetch(`${this.serverUrl.replace(/\/$/, "")}${path}`, { ...init, headers });
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}: ${await response.text()}`);
    }
    return response;
  }
}
