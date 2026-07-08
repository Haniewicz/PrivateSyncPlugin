import { Modal } from "obsidian";
import type PrivateSyncPlugin from "./plugin";

export class TextPreviewModal extends Modal {
  constructor(
    plugin: PrivateSyncPlugin,
    private readonly title: string,
    private readonly body: string
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("private-sync-preview-modal");
    this.contentEl.createEl("h2", { text: this.title });
    this.contentEl.createEl("pre", { text: this.body, cls: "private-sync-preview" });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function buildLineDiff(leftName: string, left: string, rightName: string, right: string): string {
  const leftLines = left.split(/\r?\n/);
  const rightLines = right.split(/\r?\n/);
  const max = Math.max(leftLines.length, rightLines.length);
  const lines = [`--- ${leftName}`, `+++ ${rightName}`];
  for (let index = 0; index < max; index += 1) {
    const leftLine = leftLines[index];
    const rightLine = rightLines[index];
    if (leftLine === rightLine) {
      lines.push(` ${leftLine ?? ""}`);
    } else {
      if (leftLine !== undefined) lines.push(`-${leftLine}`);
      if (rightLine !== undefined) lines.push(`+${rightLine}`);
    }
  }
  return lines.join("\n");
}

export function decodeText(content: ArrayBuffer): string {
  return new TextDecoder().decode(content);
}
