import { Modal, Notice, Setting } from "obsidian";
import type PrivateSyncPlugin from "./plugin";
import type { DevicePairingRequestPayload, DeviceType, ServerRequest } from "./types";

export class PairingApprovalModal extends Modal {
  constructor(
    private readonly plugin: PrivateSyncPlugin,
    private readonly request: ServerRequest,
    private readonly payload: DevicePairingRequestPayload,
    private readonly onDone: () => void
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Approve Private Sync device" });

    const list = contentEl.createDiv({ cls: "private-sync-list" });
    this.row(list, "Device", this.payload.deviceName);
    this.row(list, "Type", this.payload.deviceType);
    if (this.payload.ip) this.row(list, "IP", this.payload.ip);
    this.row(list, "Requested", this.payload.requestedAt ?? this.request.createdAt ?? this.request.created_at ?? "unknown");

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Later").setClass("private-sync-button").setClass("private-sync-button-subtle").onClick(() => {
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText("Approve")
          .setClass("private-sync-button")
          .setClass("private-sync-button-success")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Approving...");
            try {
              await this.plugin.api.approveDeviceRequest({
                requestId: this.request.id,
                deviceName: this.payload.deviceName,
                deviceType: this.payload.deviceType
              });
              new Notice(`Private Sync: approved ${this.payload.deviceName}.`, 8000);
              this.close();
              this.plugin.refreshView();
            } catch (error) {
              new Notice(`Private Sync approval failed: ${errorMessage(error)}`, 10000);
              button.setDisabled(false);
              button.setButtonText("Approve");
            }
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.onDone();
  }

  private row(parent: Element, name: string, value: string): void {
    const row = parent.createDiv({ cls: "private-sync-row" });
    row.createDiv({ text: name });
    row.createDiv({ text: value, cls: "private-sync-muted" });
  }
}

export function parseDevicePairingPayload(request: ServerRequest): DevicePairingRequestPayload | null {
  const rawPayload = request.payloadJson ?? request.payload_json;
  if (!rawPayload) return null;
  try {
    const payload = JSON.parse(rawPayload) as Partial<DevicePairingRequestPayload>;
    if (!payload.deviceName || !isDeviceType(payload.deviceType)) return null;
    return {
      deviceName: payload.deviceName,
      deviceType: payload.deviceType,
      requestedAt: payload.requestedAt,
      ip: payload.ip
    };
  } catch {
    return null;
  }
}

function isDeviceType(value: unknown): value is DeviceType {
  return value === "desktop" || value === "mobile" || value === "tablet" || value === "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
