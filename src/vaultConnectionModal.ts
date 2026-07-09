import { Modal, Setting } from "obsidian";
import type PrivateSyncPlugin from "./plugin";
import type { VaultConnectionAssessment, VaultManifest, VaultRiskLevel } from "./types";

export type VaultConnectionDecision = "cancel" | "replace_local" | "replace_remote";

export function openVaultConnectionModal(
  plugin: PrivateSyncPlugin,
  input: {
    vaultId: string;
    localManifest: VaultManifest;
    assessment: VaultConnectionAssessment;
  }
): Promise<VaultConnectionDecision> {
  return new Promise((resolve) => {
    new VaultConnectionModal(plugin, input, resolve).open();
  });
}

class VaultConnectionModal extends Modal {
  private resolved = false;

  constructor(
    private readonly plugin: PrivateSyncPlugin,
    private readonly input: {
      vaultId: string;
      localManifest: VaultManifest;
      assessment: VaultConnectionAssessment;
    },
    private readonly resolve: (decision: VaultConnectionDecision) => void
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: title(this.input.assessment.riskLevel) });
    contentEl.createEl("p", { text: description(this.input.assessment.riskLevel) });

    const list = contentEl.createDiv({ cls: "private-sync-list" });
    this.row(list, "Target vault", this.input.vaultId);
    this.row(list, "Safety", riskLabel(this.input.assessment.riskLevel));
    this.row(list, "Local files", `${this.input.localManifest.fileCount} files, ${this.input.localManifest.totalSize} B`);
    this.row(list, "Remote files", `${this.input.assessment.remoteFileCount} files`);
    this.row(list, "Remote revision", String(this.input.assessment.remoteRevision));
    if (this.input.assessment.previousConnection) {
      this.row(list, "Last linked", this.input.assessment.previousConnection.lastSyncedAt);
      this.row(list, "Last linked revision", String(this.input.assessment.previousConnection.lastSeenRevision));
    } else {
      this.row(list, "Last linked", "never for this local vault");
    }
    for (const reason of this.input.assessment.reasons) this.row(list, "Reason", reason);

    const actions = new Setting(contentEl).addButton((button) =>
      button.setButtonText("Cancel").setClass("private-sync-button").setClass("private-sync-button-subtle").onClick(() => {
        this.finish("cancel");
      })
    );

    if (this.input.assessment.riskLevel === "empty") {
      actions.addButton((button) => {
        button.setButtonText("Upload local files").setClass("private-sync-button").setClass("private-sync-button-primary").setCta();
        button.onClick(() => this.finish("replace_remote"));
      });
      return;
    }

    actions
      .addButton((button) => {
        button.setButtonText("Use server files").setClass("private-sync-button").setClass("private-sync-button-info");
        button.onClick(() => this.finish("replace_local"));
      })
      .addButton((button) => {
        button.setButtonText("Use local files").setClass("private-sync-button").setClass("private-sync-button-success");
        button.onClick(() => this.finish("replace_remote"));
      });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve("cancel");
  }

  private finish(decision: VaultConnectionDecision): void {
    this.resolved = true;
    this.resolve(decision);
    this.close();
  }

  private row(parent: Element, name: string, value: string): void {
    const row = parent.createDiv({ cls: "private-sync-row" });
    row.createDiv({ text: name });
    row.createDiv({ text: value, cls: "private-sync-muted" });
  }
}

function title(riskLevel: VaultRiskLevel): string {
  if (riskLevel === "empty") return "Upload this vault to an empty server vault?";
  return "Choose how to link this server vault";
}

function description(riskLevel: VaultRiskLevel): string {
  if (riskLevel === "empty") {
    return "The remote vault is empty. Private Sync can upload the current local files and permanently link this local vault to it.";
  }
  return "This remote vault already contains files. Review the safety assessment, then choose whether the server or local files should become the source of truth.";
}

function riskLabel(riskLevel: VaultRiskLevel): string {
  if (riskLevel === "high") return "High";
  if (riskLevel === "medium") return "Medium";
  if (riskLevel === "very_low") return "Very low";
  return "Empty remote vault";
}
