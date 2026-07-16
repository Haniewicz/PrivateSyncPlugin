import type { Extension } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type PrivateSyncPlugin from "./plugin";
import { findEncryptedFragments } from "./encryptedFragments";

type FragmentDisplay =
  | { status: "locked" }
  | { status: "loading" }
  | { status: "decrypted"; text: string }
  | { status: "failed"; message: string };

export function createEncryptedFragmentEditorExtension(plugin: PrivateSyncPlugin): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly refresh = () => {
        this.decorations = this.buildDecorations();
        this.view.dispatch({});
      };

      constructor(private readonly view: EditorView) {
        this.decorations = this.buildDecorations();
        window.addEventListener("private-sync-encrypted-fragments-refresh", this.refresh);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations();
        }
      }

      destroy(): void {
        window.removeEventListener("private-sync-encrypted-fragments-refresh", this.refresh);
      }

      private buildDecorations(): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const text = this.view.state.doc.toString();
        for (const fragment of findEncryptedFragments(text)) {
          const display = encryptedFragmentDisplay(plugin, fragment.marker, () => this.refresh());
          builder.add(
            fragment.start,
            fragment.end,
            Decoration.replace({
              widget: new EncryptedFragmentWidget(plugin, this.view, fragment.marker, display),
              inclusive: false
            })
          );
        }
        return builder.finish();
      }
    },
    {
      decorations: (value) => value.decorations
    }
  );
}

function encryptedFragmentDisplay(plugin: PrivateSyncPlugin, marker: string, onResolved: () => void): FragmentDisplay {
  if (!plugin.isEncryptionUnlocked()) return { status: "locked" };
  const cached = plugin.getEncryptedFragmentDisplay(marker);
  if (cached) return cached;
  plugin.decryptEncryptedFragmentForDisplay(marker)
    .then(onResolved)
    .catch(onResolved);
  return { status: "loading" };
}

class EncryptedFragmentWidget extends WidgetType {
  constructor(
    private readonly plugin: PrivateSyncPlugin,
    private readonly view: EditorView,
    private readonly marker: string,
    private readonly display: FragmentDisplay
  ) {
    super();
  }

  eq(other: EncryptedFragmentWidget): boolean {
    return this.marker === other.marker && JSON.stringify(this.display) === JSON.stringify(other.display);
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "private-sync-encrypted-fragment";
    wrapper.contentEditable = "false";

    const label = wrapper.createSpan({ text: "Encrypted", cls: "private-sync-encrypted-fragment-label" });
    label.title = "Private Sync encrypted text fragment";

    const body = wrapper.createSpan({ cls: "private-sync-encrypted-fragment-body" });
    if (this.display.status === "decrypted") {
      body.textContent = this.display.text;
    } else if (this.display.status === "loading") {
      body.textContent = "Decrypting...";
    } else if (this.display.status === "failed") {
      body.textContent = "Encrypted fragment";
      body.title = this.display.message;
      wrapper.addClass("is-error");
    } else {
      body.textContent = "Encrypted fragment";
      wrapper.addClass("is-locked");
    }

    if (this.display.status === "decrypted") {
      const actions = wrapper.createSpan({ cls: "private-sync-encrypted-fragment-actions" });
      const editButton = actions.createEl("button", { text: "Edit", cls: "private-sync-encrypted-fragment-action" });
      editButton.type = "button";
      editButton.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.plugin.editEncryptedFragmentInEditorView(this.view, this.marker, this.view.posAtDOM(wrapper));
      };

      const decryptButton = actions.createEl("button", { text: "Decrypt", cls: "private-sync-encrypted-fragment-action" });
      decryptButton.type = "button";
      decryptButton.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.plugin.decryptEncryptedFragmentInEditorView(this.view, this.marker, this.view.posAtDOM(wrapper));
      };
    }

    wrapper.onmousedown = (event) => {
      if ((event.target as HTMLElement).tagName !== "BUTTON") event.preventDefault();
    };
    return wrapper;
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== "click";
  }
}
