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

  async commit(vaultId: string, batchId: string): Promise<{ status: string; revision?: number; conflicts?: string[]; requestId?: string }> {
    return this.post(`/api/v1/vaults/${encodeURIComponent(vaultId)}/sync-batches/${encodeURIComponent(batchId)}/commit`, {});
  }

  async download(vaultId: string, path: string): Promise<ArrayBuffer> {
    const response = await this.request(
      `/api/v1/vaults/${encodeURIComponent(vaultId)}/files/download?path=${encodeURIComponent(path)}`
    );
    return response.arrayBuffer();
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
