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

type ConflictDiffSegment =
  | { type: "common"; lines: string[] }
  | { type: "conflict"; hunk: ConflictDiffHunk };

type ConflictSideChoice = "local" | "server";

export class ConflictDiffModal extends Modal {
  private choices = new Map<number, ConflictSideChoice>();
  private applyButton: HTMLButtonElement | null = null;
  private summary: HTMLElement | null = null;
  private hunks: ConflictDiffHunk[] = [];
  private segments: ConflictDiffSegment[] = [];

  constructor(
    plugin: PrivateSyncPlugin,
    private readonly title: string,
    private readonly localText: string,
    private readonly serverText: string,
    private readonly onApply?: (mergedText: string) => Promise<void>
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("private-sync-preview-modal");
    this.contentEl.createEl("h2", { text: this.title });

    const diff = buildConflictDiff(this.localText, this.serverText);
    this.hunks = diff.hunks;
    this.segments = diff.segments;
    this.choices.clear();
    if (this.hunks.length === 0) {
      this.contentEl.createDiv({ text: "No conflicting fragments.", cls: "private-sync-muted" });
      return;
    }

    this.summary = this.contentEl.createDiv({
      text: this.summaryText(),
      cls: "private-sync-muted private-sync-conflict-diff-summary"
    });
    this.summary.setAttr("aria-live", "polite");

    const list = this.contentEl.createDiv({ cls: "private-sync-conflict-diff" });
    for (const hunk of this.hunks) this.renderHunk(list, hunk);

    if (this.onApply) {
      const actions = this.contentEl.createDiv({ cls: "private-sync-conflict-merge-actions" });
      this.applyButton = actions.createEl("button", {
        text: "Apply selected fragments",
        cls: "private-sync-button private-sync-button-success"
      });
      this.applyButton.disabled = true;
      this.applyButton.onclick = () => this.applySelectedFragments();
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderHunk(parent: Element, hunk: ConflictDiffHunk): void {
    const section = parent.createDiv({ cls: "private-sync-conflict-hunk" });
    const header = section.createDiv({ cls: "private-sync-conflict-hunk-header" });
    header.createDiv({ text: `Fragment ${hunk.index}`, cls: "private-sync-conflict-hunk-title" });

    const sides = section.createDiv({ cls: "private-sync-conflict-sides" });
    this.renderSide(sides, "Local", hunk.local, "local");
    this.renderSide(sides, "Server", hunk.server, "server");

    if (this.onApply) {
      const controls = section.createDiv({ cls: "private-sync-conflict-choice-actions" });
      controls.createSpan({ text: "Use for this fragment", cls: "private-sync-conflict-choice-label" });
      const local = controls.createEl("button", {
        text: "Local",
        cls: "private-sync-button private-sync-button-subtle private-sync-conflict-choice"
      });
      const server = controls.createEl("button", {
        text: "Server",
        cls: "private-sync-button private-sync-button-subtle private-sync-conflict-choice"
      });
      local.onclick = () => this.chooseHunk(hunk.index, "local", local, server);
      server.onclick = () => this.chooseHunk(hunk.index, "server", local, server);
    }
  }

  private chooseHunk(index: number, choice: ConflictSideChoice, localButton: HTMLButtonElement, serverButton: HTMLButtonElement): void {
    this.choices.set(index, choice);
    localButton.toggleClass("is-selected", choice === "local");
    serverButton.toggleClass("is-selected", choice === "server");
    this.updateApplyState();
  }

  private updateApplyState(): void {
    if (this.summary) this.summary.setText(this.summaryText());
    if (this.applyButton) this.applyButton.disabled = this.choices.size !== this.hunks.length;
  }

  private summaryText(): string {
    const count = this.hunks.length;
    const selected = this.choices.size;
    const fragments = `${count} conflicting fragment${count === 1 ? "" : "s"}`;
    if (!this.onApply) return fragments;
    return `${fragments} · ${selected}/${count} selected`;
  }

  private async applySelectedFragments(): Promise<void> {
    if (!this.onApply || this.choices.size !== this.hunks.length) return;
    if (this.applyButton) this.applyButton.disabled = true;
    try {
      await this.onApply(mergeSelectedConflictText(this.segments, this.choices));
      this.close();
    } finally {
      if (this.applyButton) this.applyButton.disabled = this.choices.size !== this.hunks.length;
    }
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

function buildConflictDiff(localText: string, serverText: string): { hunks: ConflictDiffHunk[]; segments: ConflictDiffSegment[] } {
  const localLines = splitTextLines(localText);
  const serverLines = splitTextLines(serverText);
  const matches = longestCommonLineMatches(localLines, serverLines);
  const hunks: ConflictDiffHunk[] = [];
  const segments: ConflictDiffSegment[] = [];
  let previousLocal = 0;
  let previousServer = 0;

  for (const match of [...matches, { localIndex: localLines.length, serverIndex: serverLines.length }]) {
    if (previousLocal < match.localIndex || previousServer < match.serverIndex) {
      const hunk = {
        index: hunks.length + 1,
        local: {
          startLine: previousLocal + 1,
          lines: localLines.slice(previousLocal, match.localIndex)
        },
        server: {
          startLine: previousServer + 1,
          lines: serverLines.slice(previousServer, match.serverIndex)
        }
      };
      hunks.push(hunk);
      segments.push({ type: "conflict", hunk });
    }
    if (match.localIndex < localLines.length && match.serverIndex < serverLines.length) {
      segments.push({ type: "common", lines: [localLines[match.localIndex]] });
    }
    previousLocal = match.localIndex + 1;
    previousServer = match.serverIndex + 1;
  }

  return { hunks, segments };
}

function mergeSelectedConflictText(segments: ConflictDiffSegment[], choices: Map<number, ConflictSideChoice>): string {
  const lines: string[] = [];
  for (const segment of segments) {
    if (segment.type === "common") {
      lines.push(...segment.lines);
      continue;
    }
    const choice = choices.get(segment.hunk.index);
    lines.push(...(choice === "server" ? segment.hunk.server.lines : segment.hunk.local.lines));
  }
  return lines.join("\n");
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
