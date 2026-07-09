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

type ConflictDiffSide = {
  startLine: number;
  lines: string[];
};

type ConflictDiffHunk = {
  index: number;
  local: ConflictDiffSide;
  server: ConflictDiffSide;
};

export class ConflictDiffModal extends Modal {
  constructor(
    plugin: PrivateSyncPlugin,
    private readonly title: string,
    private readonly localText: string,
    private readonly serverText: string
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("private-sync-preview-modal");
    this.contentEl.createEl("h2", { text: this.title });

    const hunks = buildConflictDiffHunks(this.localText, this.serverText);
    if (hunks.length === 0) {
      this.contentEl.createDiv({ text: "No conflicting fragments.", cls: "private-sync-muted" });
      return;
    }

    const summary = this.contentEl.createDiv({
      text: `${hunks.length} conflicting fragment${hunks.length === 1 ? "" : "s"}`,
      cls: "private-sync-muted private-sync-conflict-diff-summary"
    });
    summary.setAttr("aria-live", "polite");

    const list = this.contentEl.createDiv({ cls: "private-sync-conflict-diff" });
    for (const hunk of hunks) this.renderHunk(list, hunk);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderHunk(parent: Element, hunk: ConflictDiffHunk): void {
    const section = parent.createDiv({ cls: "private-sync-conflict-hunk" });
    section.createDiv({ text: `Fragment ${hunk.index}`, cls: "private-sync-conflict-hunk-title" });

    const sides = section.createDiv({ cls: "private-sync-conflict-sides" });
    this.renderSide(sides, "Local", hunk.local, "local");
    this.renderSide(sides, "Server", hunk.server, "server");
  }

  private renderSide(parent: Element, label: string, side: ConflictDiffSide, tone: "local" | "server"): void {
    const panel = parent.createDiv({ cls: `private-sync-conflict-side private-sync-conflict-side-${tone}` });
    panel.createDiv({ text: `${label} ${lineRangeLabel(side)}`, cls: "private-sync-conflict-side-title" });
    const code = panel.createDiv({ cls: "private-sync-conflict-code" });
    if (side.lines.length === 0) {
      code.createEl("code", { text: "(no lines)" });
      return;
    }
    side.lines.forEach((line, index) => {
      const row = code.createDiv({ cls: "private-sync-conflict-line" });
      row.createSpan({ text: String(side.startLine + index), cls: "private-sync-conflict-line-number" });
      row.createSpan({ text: line, cls: "private-sync-conflict-line-text" });
    });
  }
}

function buildConflictDiffHunks(localText: string, serverText: string): ConflictDiffHunk[] {
  const localLines = splitTextLines(localText);
  const serverLines = splitTextLines(serverText);
  const matches = longestCommonLineMatches(localLines, serverLines);
  const hunks: ConflictDiffHunk[] = [];
  let previousLocal = 0;
  let previousServer = 0;

  for (const match of [...matches, { localIndex: localLines.length, serverIndex: serverLines.length }]) {
    if (previousLocal < match.localIndex || previousServer < match.serverIndex) {
      hunks.push({
        index: hunks.length + 1,
        local: {
          startLine: previousLocal + 1,
          lines: localLines.slice(previousLocal, match.localIndex)
        },
        server: {
          startLine: previousServer + 1,
          lines: serverLines.slice(previousServer, match.serverIndex)
        }
      });
    }
    previousLocal = match.localIndex + 1;
    previousServer = match.serverIndex + 1;
  }

  return hunks;
}

function longestCommonLineMatches(localLines: string[], serverLines: string[]): Array<{ localIndex: number; serverIndex: number }> {
  const rows = localLines.length + 1;
  const columns = serverLines.length + 1;
  if (rows * columns > 1_000_000) return indexAlignedMatches(localLines, serverLines);

  const table = Array.from({ length: rows }, () => new Uint32Array(columns));
  for (let localIndex = localLines.length - 1; localIndex >= 0; localIndex -= 1) {
    for (let serverIndex = serverLines.length - 1; serverIndex >= 0; serverIndex -= 1) {
      table[localIndex][serverIndex] =
        localLines[localIndex] === serverLines[serverIndex]
          ? table[localIndex + 1][serverIndex + 1] + 1
          : Math.max(table[localIndex + 1][serverIndex], table[localIndex][serverIndex + 1]);
    }
  }

  const matches: Array<{ localIndex: number; serverIndex: number }> = [];
  let localIndex = 0;
  let serverIndex = 0;
  while (localIndex < localLines.length && serverIndex < serverLines.length) {
    if (localLines[localIndex] === serverLines[serverIndex]) {
      matches.push({ localIndex, serverIndex });
      localIndex += 1;
      serverIndex += 1;
    } else if (table[localIndex + 1][serverIndex] >= table[localIndex][serverIndex + 1]) {
      localIndex += 1;
    } else {
      serverIndex += 1;
    }
  }
  return matches;
}

function indexAlignedMatches(localLines: string[], serverLines: string[]): Array<{ localIndex: number; serverIndex: number }> {
  const matches: Array<{ localIndex: number; serverIndex: number }> = [];
  const max = Math.min(localLines.length, serverLines.length);
  for (let index = 0; index < max; index += 1) {
    if (localLines[index] === serverLines[index]) matches.push({ localIndex: index, serverIndex: index });
  }
  return matches;
}

function lineRangeLabel(side: ConflictDiffSide): string {
  if (side.lines.length === 0) return "no lines";
  if (side.lines.length === 1) return `line ${side.startLine}`;
  return `lines ${side.startLine}-${side.startLine + side.lines.length - 1}`;
}

function splitTextLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

export function decodeText(content: ArrayBuffer): string {
  return new TextDecoder().decode(content);
}
