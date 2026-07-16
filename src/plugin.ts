import type { EditorView } from "@codemirror/view";
import { Editor, Modal, Notice, Plugin, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { ApiClient } from "./apiClient";
import { createEncryptionKeyCheck, decryptTextFragment, encryptTextFragment, uuid, verifyEncryptionKeyCheck } from "./crypto";
import { DEFAULT_SETTINGS } from "./defaults";
import { createEncryptedFragmentEditorExtension } from "./encryptedFragmentEditor";
import { findEncryptedFragmentAtOffset, findEncryptedFragments, type EncryptedFragmentRange } from "./encryptedFragments";
import { LocalIndexStore } from "./localIndex";
import { decryptNoteBodyText, markNoteForServerEncryption, unmarkNoteForServerEncryption } from "./noteEncryption";
import { PairingApprovalModal, parseDevicePairingPayload } from "./pairingApprovalModal";
import { PrivateSyncSettingTab } from "./settingsTab";
import { SyncEngine } from "./syncEngine";
import { PRIVATE_SYNC_VIEW, PrivateSyncView } from "./statusView";
import type { LocalIndex, PluginSettings, ServerRequest, SyncEvent, VaultEncryptionKey } from "./types";

type StoredData = {
  settings?: Partial<PluginSettings>;
  index?: LocalIndex;
  events?: SyncEvent[];
};

type AggregatedNotice = {
  count: number;
  message: string;
  timeout: number;
  aggregateMessage: (count: number) => string;
  timer: number;
};

type EncryptedFragmentDisplay =
  | { status: "decrypted"; text: string }
  | { status: "failed"; message: string };

const ENCRYPTION_SECRET_ID = "private-sync-encryption-passphrase";

export default class PrivateSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  events: SyncEvent[] = [];
  indexStore = new LocalIndexStore(this);
  api = new ApiClient(this.settings.serverUrl, () => this.settings.deviceToken);
  syncEngine = new SyncEngine(this, this.indexStore, this.api);
  private socket: WebSocket | null = null;
  private reconnectTimeout: number | null = null;
  private statusBarItem: HTMLElement | null = null;
  private encryptionPassphrase = "";
  private activeEncryptionKey: VaultEncryptionKey | null = null;
  private offlineNoticeShown = false;
  private activePairingRequestModals = new Set<string>();
  private unloading = false;
  private aggregatedNotices = new Map<string, AggregatedNotice>();
  private encryptedFragmentDisplayCache = new Map<string, EncryptedFragmentDisplay>();
  private encryptedFragmentDecrypts = new Map<string, Promise<string>>();

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.loadRememberedEncryptionPassphrase();
    await this.loadEvents();
    await this.indexStore.load();
    this.recreateApi();

    this.registerView(PRIVATE_SYNC_VIEW, (leaf: WorkspaceLeaf) => new PrivateSyncView(leaf, this));
    this.registerEditorExtension(createEncryptedFragmentEditorExtension(this));
    this.registerMarkdownPostProcessor((element) => {
      void this.renderEncryptedFragmentsInPreview(element);
    });
    this.addRibbonIcon("refresh-cw", "Private Sync", () => this.activateView());
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("private-sync-status-bar");
    this.updateConnectionStatus();
    this.addSettingTab(new PrivateSyncSettingTab(this.app, this));

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncEngine.syncNow()
    });
    this.addCommand({
      id: "pair-device",
      name: "Pair this device",
      callback: () => void this.syncEngine.pairDevice()
    });
    this.addCommand({
      id: "open-panel",
      name: "Open sync panel",
      callback: () => void this.activateView()
    });
    this.addCommand({
      id: "check-pairing-requests",
      name: "Check pairing requests",
      callback: () => void this.checkPairingRequests()
    });
    this.addCommand({
      id: "encrypt-selection",
      name: "Encrypt selected text",
      editorCallback: (editor) => void this.encryptEditorSelection(editor)
    });
    this.addCommand({
      id: "decrypt-selection",
      name: "Decrypt selected encrypted text",
      editorCallback: (editor) => void this.decryptEditorSelection(editor)
    });
    this.addCommand({
      id: "edit-encrypted-fragment-at-cursor",
      name: "Edit encrypted fragment at cursor",
      editorCallback: (editor) => void this.editEncryptedFragmentAtCursor(editor)
    });
    this.addCommand({
      id: "decrypt-encrypted-fragment-at-cursor",
      name: "Decrypt encrypted fragment at cursor",
      editorCallback: (editor) => void this.decryptEncryptedFragmentAtCursor(editor)
    });
    this.addCommand({
      id: "encrypt-note-body",
      name: "Encrypt current note on server",
      editorCallback: (editor) => void this.markCurrentNoteForServerEncryption(editor)
    });
    this.addCommand({
      id: "decrypt-note-body",
      name: "Decrypt current note body",
      editorCallback: (editor) => void this.decryptCurrentNoteBody(editor)
    });
    this.addCommand({
      id: "enable-note-auto-encryption",
      name: "Enable server encryption for current note",
      editorCallback: (editor) => void this.markCurrentNoteForServerEncryption(editor)
    });
    this.addCommand({
      id: "disable-note-auto-encryption",
      name: "Disable server encryption for current note",
      editorCallback: (editor) => void this.disableCurrentNoteAutoEncryption(editor)
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && this.settings.autoSync) void this.debouncedSync();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", () => {
        if (this.settings.autoSync) void this.debouncedSync();
      })
    );
    this.registerEvent(
      this.app.vault.on("create", () => {
        if (this.settings.autoSync) void this.debouncedSync();
      })
    );

    this.registerMobileLifecycleHandlers();
    this.app.workspace.onLayoutReady(() => void this.handleAppBecameActive("layout-ready"));
  }

  onunload(): void {
    this.unloading = true;
    this.clearReconnectTimer();
    this.closeSocket();
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as StoredData | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    if (!data?.settings?.localVaultInstanceId) {
      this.settings.localVaultInstanceId = uuid();
      await this.savePluginData({ settings: this.settings });
    }
    if (data?.settings?.deviceToken && data.settings.vaultLinked === undefined) {
      this.settings.vaultLinked = true;
      await this.savePluginData({ settings: this.settings });
    }
  }

  async saveSettings(): Promise<void> {
    this.recreateApi();
    await this.savePluginData({ settings: this.settings });
  }

  isEncryptionUnlocked(): boolean {
    return Boolean(this.encryptionPassphrase);
  }

  requireEncryptionPassphrase(): string {
    if (!this.settings.encryptionKeyCheck) throw new Error("Set an encryption passphrase in Private Sync settings first.");
    if (!this.encryptionPassphrase) throw new Error("Unlock the Private Sync encryption passphrase first.");
    return this.encryptionPassphrase;
  }

  getLocalEncryptionPassphrase(): string | null {
    if (this.encryptionPassphrase) return this.encryptionPassphrase;
    if (!this.settings.rememberEncryptionPassphrase) return null;
    return this.app.secretStorage.getSecret(ENCRYPTION_SECRET_ID) || null;
  }

  async setEncryptionPassphrase(passphrase: string, currentPassphrase = ""): Promise<void> {
    const trimmed = passphrase.trim();
    const current = currentPassphrase.trim();
    if (!trimmed) throw new Error("Encryption passphrase cannot be empty.");
    if (!this.settings.deviceToken || !this.settings.vaultId) throw new Error("Pair and link a server vault before setting encryption.");
    const active = await this.fetchActiveEncryptionKey();
    if (active) {
      const currentCandidate = current || this.encryptionPassphrase;
      if (!currentCandidate) throw new Error("Enter the current encryption passphrase before changing it.");
      if (!(await verifyEncryptionKeyCheck(active.keyCheck, currentCandidate))) throw new Error("Current encryption passphrase is incorrect.");
    }
    const keyCheck = await createEncryptionKeyCheck(trimmed);
    const key = active && (await verifyEncryptionKeyCheck(active.keyCheck, trimmed))
      ? { id: active.id, keyCheck: active.keyCheck }
      : await this.api.createEncryptionKey(this.settings.vaultId, keyCheck);
    this.activeEncryptionKey = { id: key.id, keyCheck: key.keyCheck, active: true, createdAt: new Date().toISOString() };
    this.settings.encryptionKeyCheck = key.keyCheck;
    this.settings.encryptionKeyId = key.id;
    this.encryptionPassphrase = trimmed;
    if (this.settings.rememberEncryptionPassphrase) this.rememberEncryptionPassphrase(trimmed);
    await this.saveSettings();
    if (active && active.id !== key.id) await this.syncEngine.queueEncryptedUploadsForRotation();
    this.refreshEncryptedFragmentDisplays();
    this.refreshView();
    this.syncAfterEncryptionUnlock();
  }

  async unlockEncryption(passphrase: string): Promise<void> {
    const trimmed = passphrase.trim();
    const active = await this.fetchActiveEncryptionKey();
    if (!active && !this.settings.encryptionKeyCheck) throw new Error("Set an encryption passphrase first.");
    if (active && !(await verifyEncryptionKeyCheck(active.keyCheck, trimmed))) {
      throw new Error("Encryption passphrase is incorrect.");
    }
    if (!active && !(await verifyEncryptionKeyCheck(this.settings.encryptionKeyCheck, trimmed))) {
      throw new Error("Encryption passphrase is incorrect.");
    }
    if (!active && this.settings.encryptionKeyCheck) {
      const key = await this.api.createEncryptionKey(this.settings.vaultId, this.settings.encryptionKeyCheck);
      this.activeEncryptionKey = { id: key.id, keyCheck: key.keyCheck, active: true, createdAt: key.createdAt };
      this.settings.encryptionKeyId = key.id;
    }
    this.encryptionPassphrase = trimmed;
    if (active) {
      this.settings.encryptionKeyCheck = active.keyCheck;
      this.settings.encryptionKeyId = active.id;
    }
    if (this.settings.rememberEncryptionPassphrase) this.rememberEncryptionPassphrase(trimmed);
    await this.saveSettings();
    this.refreshEncryptedFragmentDisplays();
    this.refreshView();
    this.syncAfterEncryptionUnlock();
  }

  lockEncryption(): void {
    this.encryptionPassphrase = "";
    this.encryptedFragmentDisplayCache.clear();
    this.encryptedFragmentDecrypts.clear();
    this.refreshEncryptedFragmentDisplays();
    this.refreshView();
  }

  async setRememberEncryptionPassphrase(remember: boolean): Promise<void> {
    this.settings.rememberEncryptionPassphrase = remember;
    if (remember && this.encryptionPassphrase) {
      this.rememberEncryptionPassphrase(this.encryptionPassphrase);
    } else if (!remember) {
      this.forgetEncryptionPassphrase();
    }
    await this.saveSettings();
  }

  private async loadRememberedEncryptionPassphrase(): Promise<void> {
    if (!this.settings.rememberEncryptionPassphrase || !this.settings.encryptionKeyCheck) return;
    const passphrase = this.app.secretStorage.getSecret(ENCRYPTION_SECRET_ID);
    if (!passphrase) return;
    if (await verifyEncryptionKeyCheck(this.settings.encryptionKeyCheck, passphrase)) {
      this.encryptionPassphrase = passphrase;
      this.refreshEncryptedFragmentDisplays();
    } else {
      this.forgetEncryptionPassphrase();
    }
  }

  async ensureEncryptionReadyForUpload(): Promise<string> {
    const passphrase = this.requireEncryptionPassphrase();
    const active = await this.fetchActiveEncryptionKey();
    if (!active) {
      if (!this.settings.encryptionKeyCheck || !(await verifyEncryptionKeyCheck(this.settings.encryptionKeyCheck, passphrase))) {
        throw new Error("Set the server encryption passphrase first.");
      }
      const key = await this.api.createEncryptionKey(this.settings.vaultId, this.settings.encryptionKeyCheck);
      this.activeEncryptionKey = { id: key.id, keyCheck: key.keyCheck, active: true, createdAt: key.createdAt };
      this.settings.encryptionKeyId = key.id;
      await this.saveSettings();
      return key.id;
    }
    if (!active.id) throw new Error("Server returned an active encryption key without an id. Re-pair or update Private Sync before uploading encrypted files.");
    if (!(await verifyEncryptionKeyCheck(active.keyCheck, passphrase))) throw new Error("Encryption passphrase does not match this server vault.");
    this.settings.encryptionKeyCheck = active.keyCheck;
    this.settings.encryptionKeyId = active.id;
    await this.saveSettings();
    return active.id;
  }

  async ensureEncryptionReadyForDownload(encryptionKeyId: string | null): Promise<void> {
    const passphrase = this.requireEncryptionPassphrase();
    const active = await this.fetchActiveEncryptionKey();
    const keyCheck = active?.keyCheck ?? this.settings.encryptionKeyCheck;
    if (!keyCheck) throw new Error("Set the server encryption passphrase first.");
    if (encryptionKeyId && active && encryptionKeyId !== active.id) {
      throw new Error("This revision was encrypted with an older passphrase. Use the history view and enter that old passphrase.");
    }
    if (!(await verifyEncryptionKeyCheck(keyCheck, passphrase))) throw new Error("Encryption passphrase does not match this server vault.");
  }

  async getEncryptionKeyForRevision(encryptionKeyId: string | null | undefined): Promise<VaultEncryptionKey | null> {
    const response = await this.api.getEncryptionKeys(this.settings.vaultId);
    return response.keys.find((key) => key.id === encryptionKeyId) ?? null;
  }

  private async fetchActiveEncryptionKey(): Promise<VaultEncryptionKey | null> {
    if (!this.settings.deviceToken || !this.settings.vaultId) return null;
    const response = await this.api.getEncryptionKeys(this.settings.vaultId);
    const active = response.active;
    this.activeEncryptionKey = active;
    if (active) {
      this.settings.encryptionKeyCheck = active.keyCheck;
      this.settings.encryptionKeyId = active.id;
    }
    return active;
  }

  private rememberEncryptionPassphrase(passphrase: string): void {
    this.app.secretStorage.setSecret(ENCRYPTION_SECRET_ID, passphrase);
  }

  private forgetEncryptionPassphrase(): void {
    this.app.secretStorage.setSecret(ENCRYPTION_SECRET_ID, "");
  }

  private syncAfterEncryptionUnlock(): void {
    if (!this.settings.deviceToken || !this.settings.vaultLinked) return;
    if (this.handleOfflineSyncAttempt()) return;
    this.syncEngine.syncNow().catch((error) => {
      this.recordErrorEvent("Sync after encryption unlock failed", error).catch(() => undefined);
      new Notice(`Private Sync: ${errorMessage(error)}`, 10000);
    });
  }

  async savePluginData(partial: StoredData): Promise<void> {
    const existing = ((await this.loadData()) as StoredData | null) ?? {};
    await this.saveData({ ...existing, ...partial });
  }

  async loadEvents(): Promise<void> {
    const data = (await this.loadData()) as StoredData | null;
    this.events = data?.events ?? [];
  }

  async recordSyncEvent(event: Omit<SyncEvent, "timestamp"> & { timestamp?: string }): Promise<void> {
    this.events = [{ ...event, timestamp: event.timestamp ?? new Date().toISOString() }, ...this.events].slice(0, 200);
    await this.savePluginData({ events: this.events });
    this.refreshView();
  }

  async recordErrorEvent(message: string, error: unknown): Promise<void> {
    await this.recordSyncEvent({
      type: "error",
      message: `${message}: ${errorMessage(error)}`,
      details: errorDetails(error)
    });
  }

  showAggregatedNotice(
    key: string,
    message: string,
    aggregateMessage: (count: number) => string,
    timeout = 8000,
    delay = 750
  ): void {
    const existing = this.aggregatedNotices.get(key);
    if (existing) {
      window.clearTimeout(existing.timer);
      existing.count += 1;
      existing.message = message;
      existing.timeout = timeout;
      existing.aggregateMessage = aggregateMessage;
      existing.timer = window.setTimeout(() => this.flushAggregatedNotice(key), delay);
      return;
    }

    const notice: AggregatedNotice = {
      count: 1,
      message,
      timeout,
      aggregateMessage,
      timer: window.setTimeout(() => this.flushAggregatedNotice(key), delay)
    };
    this.aggregatedNotices.set(key, notice);
  }

  private flushAggregatedNotice(key: string): void {
    const notice = this.aggregatedNotices.get(key);
    if (!notice) return;
    this.aggregatedNotices.delete(key);
    new Notice(notice.count === 1 ? notice.message : notice.aggregateMessage(notice.count), notice.timeout);
  }

  async clearSyncEvents(predicate?: (event: SyncEvent) => boolean): Promise<void> {
    this.events = predicate ? this.events.filter((event) => !predicate(event)) : [];
    await this.savePluginData({ events: this.events });
    this.refreshView();
  }

  refreshView(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(PRIVATE_SYNC_VIEW)) {
      const view = leaf.view;
      if (view instanceof PrivateSyncView) view.refresh();
    }
  }

  refreshEncryptedFragmentDisplays(): void {
    window.dispatchEvent(new CustomEvent("private-sync-encrypted-fragments-refresh"));
    this.refreshEncryptedFragmentPreviewDisplays();
  }

  getEncryptedFragmentDisplay(marker: string): EncryptedFragmentDisplay | null {
    return this.encryptedFragmentDisplayCache.get(marker) ?? null;
  }

  async decryptEncryptedFragmentForDisplay(marker: string): Promise<string> {
    const cached = this.encryptedFragmentDisplayCache.get(marker);
    if (cached?.status === "decrypted") return cached.text;
    const pending = this.encryptedFragmentDecrypts.get(marker);
    if (pending) return pending;

    const decrypt = decryptTextFragment(marker, this.requireEncryptionPassphrase())
      .then((text) => {
        this.encryptedFragmentDisplayCache.set(marker, { status: "decrypted", text });
        this.encryptedFragmentDecrypts.delete(marker);
        return text;
      })
      .catch((error) => {
        this.encryptedFragmentDisplayCache.set(marker, { status: "failed", message: errorMessage(error) });
        this.encryptedFragmentDecrypts.delete(marker);
        throw error;
      });
    this.encryptedFragmentDecrypts.set(marker, decrypt);
    return decrypt;
  }

  async editEncryptedFragmentInEditorView(view: EditorView, marker: string, position?: number): Promise<void> {
    try {
      const fragment = this.findFragmentInEditorView(view, marker, position);
      if (!fragment) throw new Error("Encrypted fragment was not found.");
      const plaintext = await this.decryptEncryptedFragmentForDisplay(fragment.marker);
      new EncryptedFragmentEditModal(this, plaintext, async (nextText) => {
        const currentFragment = this.findFreshFragment(view.state.doc.toString(), fragment);
        if (!currentFragment) throw new Error("Encrypted fragment changed before it could be saved.");
        const nextMarker = await encryptTextFragment(nextText, this.requireEncryptionPassphrase());
        view.dispatch({
          changes: { from: currentFragment.start, to: currentFragment.end, insert: nextMarker },
          selection: { anchor: currentFragment.start + nextMarker.length }
        });
        this.encryptedFragmentDisplayCache.delete(fragment.marker);
        this.encryptedFragmentDisplayCache.set(nextMarker, { status: "decrypted", text: nextText });
        this.refreshEncryptedFragmentDisplays();
        new Notice("Private Sync: encrypted fragment updated.", 5000);
      }).open();
    } catch (error) {
      new Notice(`Private Sync encrypted fragment edit failed: ${errorMessage(error)}`, 10000);
    }
  }

  async decryptEncryptedFragmentInEditorView(view: EditorView, marker: string, position?: number): Promise<void> {
    try {
      const fragment = this.findFragmentInEditorView(view, marker, position);
      if (!fragment) throw new Error("Encrypted fragment was not found.");
      const plaintext = await this.decryptEncryptedFragmentForDisplay(fragment.marker);
      const currentFragment = this.findFreshFragment(view.state.doc.toString(), fragment);
      if (!currentFragment) throw new Error("Encrypted fragment changed before it could be replaced.");
      view.dispatch({
        changes: { from: currentFragment.start, to: currentFragment.end, insert: plaintext },
        selection: { anchor: currentFragment.start + plaintext.length }
      });
      this.encryptedFragmentDisplayCache.delete(fragment.marker);
      this.refreshEncryptedFragmentDisplays();
      new Notice("Private Sync: encrypted fragment decrypted to plain text.", 7000);
    } catch (error) {
      new Notice(`Private Sync fragment decryption failed: ${errorMessage(error)}`, 10000);
    }
  }

  private findFragmentInEditorView(view: EditorView, marker: string, position?: number): EncryptedFragmentRange | null {
    const fragments = findEncryptedFragments(view.state.doc.toString()).filter((fragment) => fragment.marker === marker);
    if (fragments.length === 0) return null;
    if (position === undefined) return fragments[0];
    return fragments.find((fragment) => position >= fragment.start && position <= fragment.end)
      ?? fragments.sort((left, right) => Math.abs(left.start - position) - Math.abs(right.start - position))[0];
  }

  private findFreshFragment(text: string, original: EncryptedFragmentRange): EncryptedFragmentRange | null {
    if (text.slice(original.start, original.end) === original.marker) return original;
    return findEncryptedFragments(text).find((fragment) => fragment.marker === original.marker) ?? null;
  }

  async checkPairingRequests(): Promise<void> {
    if (this.handleOfflineSyncAttempt()) return;
    if (!this.settings.deviceToken || !this.settings.vaultId) return;
    try {
      const response = await this.api.requests(this.settings.vaultId);
      for (const request of response.requests) {
        this.maybeOpenPairingApproval(request);
      }
      this.refreshView();
    } catch (error) {
      await this.recordErrorEvent("Cannot load pairing requests", error);
      new Notice(`Private Sync: cannot load pairing requests: ${errorMessage(error)}`, 10000);
    }
  }

  private recreateApi(): void {
    this.api = new ApiClient(this.settings.serverUrl, () => this.settings.deviceToken);
    this.syncEngine = new SyncEngine(this, this.indexStore, this.api);
    this.reconnectEvents();
  }

  private async activateView(): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: PRIVATE_SYNC_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private debouncedSync = debounce(async () => {
    if (!this.settings.deviceToken) return;
    if (!this.settings.vaultLinked) return;
    if (this.handleOfflineSyncAttempt()) return;
    try {
      await this.syncEngine.syncNow();
    } catch (error) {
      await this.recordErrorEvent("Sync failed", error);
      new Notice(`Private Sync: ${errorMessage(error)}`);
    }
  }, 1500);

  private registerMobileLifecycleHandlers(): void {
    const onActive = () => this.handleAppBecameActive("app-active");
    const onHidden = () => this.handleAppWentInactive();
    const onOffline = () => {
      this.handleAppWentInactive();
      this.handleOfflineSyncAttempt();
    };

    this.registerDomEvent(window, "focus", onActive);
    this.registerDomEvent(window, "pageshow", onActive);
    this.registerDomEvent(window, "online", onActive);
    this.registerDomEvent(window, "offline", onOffline);
    this.registerDomEvent(activeDocument, "visibilitychange", () => {
      if (activeDocument.visibilityState === "visible") {
        void this.handleAppBecameActive("visible");
      } else {
        onHidden();
      }
    });
  }

  private handleAppBecameActive(_reason: string): void {
    if (!this.isOffline()) {
      this.offlineNoticeShown = false;
    }
    this.updateConnectionStatus();
    if (!this.settings.deviceToken) return;
    if (!this.settings.vaultLinked) return;
    if (this.handleOfflineSyncAttempt()) return;
    this.reconnectEvents();
    void this.checkPairingRequests();
    if (this.settings.autoSync) void this.debouncedSync();
  }

  private handleAppWentInactive(): void {
    this.clearReconnectTimer();
    this.closeSocket();
  }

  private reconnectEvents(): void {
    this.clearReconnectTimer();
    this.closeSocket();
    this.connectEvents();
  }

  private connectEvents(): void {
    if (!this.settings.deviceToken || this.unloading) return;
    if (!this.settings.vaultLinked) return;
    if (this.isOffline()) return;
    if (activeDocument.visibilityState === "hidden") return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;

    const url = this.settings.serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + `/api/v1/events?token=${encodeURIComponent(this.settings.deviceToken)}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      void this.checkPairingRequests();
      if (this.settings.autoSync) void this.debouncedSync();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const message = parseServerEvent(event.data);
      if (message.type === "request_created") {
        void this.checkPairingRequests();
      }
      if (message.type === "vault_changed" || message.type === "conflict_created") {
        if (!this.handleOfflineSyncAttempt()) {
          this.syncEngine.syncNow().catch((error) => new Notice(`Private Sync: ${errorMessage(error)}`));
        }
      }
      if (message.type === "conflict_resolved") {
        this.refreshView();
      }
      if (message.type === "vault_updated" && message.vault_id === this.settings.vaultId && typeof message.name === "string") {
        this.settings.vaultName = message.name;
        this.saveSettings().catch((error) => new Notice(`Private Sync: cannot save renamed vault: ${errorMessage(error)}`, 10000));
      }
      if (
        message.type === "request_resolved" ||
        message.type === "device_revoked" ||
        message.type === "device_restored" ||
        message.type === "device_updated" ||
        message.type === "device_deleted" ||
        message.type === "vault_updated" ||
        message.type === "vault_deleted"
      ) {
        this.refreshView();
      }
      this.refreshView();
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.unloading && activeDocument.visibilityState !== "hidden") {
        this.scheduleReconnect();
      }
    };
    socket.onerror = () => {
      if (this.socket === socket) socket.close();
    };
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null;
      this.connectEvents();
    }, 5000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimeout !== null) {
      window.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
    this.socket = null;
  }

  private maybeOpenPairingApproval(request: ServerRequest): void {
    if (request.type !== "device_pairing" || request.status !== "pending") return;
    if (this.activePairingRequestModals.has(request.id)) return;
    const payload = parseDevicePairingPayload(request);
    if (!payload) return;
    this.activePairingRequestModals.add(request.id);
    new PairingApprovalModal(this, request, payload, () => {
      this.activePairingRequestModals.delete(request.id);
    }).open();
  }

  isOffline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  handleOfflineSyncAttempt(): boolean {
    if (!this.isOffline()) return false;
    this.updateConnectionStatus();
    if (!this.offlineNoticeShown) {
      this.offlineNoticeShown = true;
      void this.recordSyncEvent({
        type: "offline",
        message: "Jesteś offline. Dane nie są synchronizowane"
      });
      new Notice("Jesteś offline. Dane nie są synchronizowane", 10000);
    }
    return true;
  }

  private async encryptEditorSelection(editor: Editor): Promise<void> {
    try {
      const selected = editor.getSelection();
      if (!selected) throw new Error("Select text to encrypt first.");
      const marker = await encryptTextFragment(selected, this.requireEncryptionPassphrase());
      editor.replaceSelection(marker);
      new Notice("Private Sync: encrypted selected text.", 5000);
    } catch (error) {
      new Notice(`Private Sync encryption failed: ${errorMessage(error)}`, 10000);
    }
  }

  private async decryptEditorSelection(editor: Editor): Promise<void> {
    try {
      const target = findEncryptedMarker(editor);
      if (!target) throw new Error("Select an encrypted marker or place the cursor inside one.");
      const text = await decryptTextFragment(target.text, this.requireEncryptionPassphrase());
      editor.replaceRange(text, target.from, target.to);
      new Notice("Private Sync: decrypted selected text.", 5000);
    } catch (error) {
      new Notice(`Private Sync decryption failed: ${errorMessage(error)}`, 10000);
    }
  }

  private async editEncryptedFragmentAtCursor(editor: Editor): Promise<void> {
    try {
      const target = findEncryptedMarker(editor);
      if (!target) throw new Error("Place the cursor inside an encrypted fragment first.");
      const plaintext = await this.decryptEncryptedFragmentForDisplay(target.text);
      new EncryptedFragmentEditModal(this, plaintext, async (nextText) => {
        const currentText = editor.getValue();
        const fragment = findEncryptedFragmentAtOffset(currentText, editor.posToOffset(target.from));
        if (!fragment || fragment.marker !== target.text) throw new Error("Encrypted fragment changed before it could be saved.");
        const nextMarker = await encryptTextFragment(nextText, this.requireEncryptionPassphrase());
        editor.replaceRange(nextMarker, editor.offsetToPos(fragment.start), editor.offsetToPos(fragment.end));
        this.encryptedFragmentDisplayCache.delete(target.text);
        this.encryptedFragmentDisplayCache.set(nextMarker, { status: "decrypted", text: nextText });
        this.refreshEncryptedFragmentDisplays();
        new Notice("Private Sync: encrypted fragment updated.", 5000);
      }).open();
    } catch (error) {
      new Notice(`Private Sync encrypted fragment edit failed: ${errorMessage(error)}`, 10000);
    }
  }

  private async decryptEncryptedFragmentAtCursor(editor: Editor): Promise<void> {
    try {
      const target = findEncryptedMarker(editor);
      if (!target) throw new Error("Place the cursor inside an encrypted fragment first.");
      const plaintext = await this.decryptEncryptedFragmentForDisplay(target.text);
      const currentText = editor.getValue();
      const fragment = findEncryptedFragmentAtOffset(currentText, editor.posToOffset(target.from));
      if (!fragment || fragment.marker !== target.text) throw new Error("Encrypted fragment changed before it could be replaced.");
      editor.replaceRange(plaintext, editor.offsetToPos(fragment.start), editor.offsetToPos(fragment.end));
      this.encryptedFragmentDisplayCache.delete(target.text);
      this.refreshEncryptedFragmentDisplays();
      new Notice("Private Sync: encrypted fragment decrypted to plain text.", 7000);
    } catch (error) {
      new Notice(`Private Sync fragment decryption failed: ${errorMessage(error)}`, 10000);
    }
  }

  private markCurrentNoteForServerEncryption(editor: Editor): void {
    try {
      editor.setValue(markNoteForServerEncryption(editor.getValue()));
      new Notice("Private Sync: this note will stay readable locally and be encrypted before upload.", 7000);
    } catch (error) {
      new Notice(`Private Sync: cannot mark note for encryption: ${errorMessage(error)}`, 10000);
    }
  }

  private async decryptCurrentNoteBody(editor: Editor): Promise<void> {
    try {
      const decrypted = await decryptNoteBodyText(editor.getValue(), this.requireEncryptionPassphrase());
      editor.setValue(decrypted);
      new Notice("Private Sync: note body decrypted.", 5000);
    } catch (error) {
      new Notice(`Private Sync note decryption failed: ${errorMessage(error)}`, 10000);
    }
  }

  private disableCurrentNoteAutoEncryption(editor: Editor): void {
    try {
      editor.setValue(unmarkNoteForServerEncryption(editor.getValue()));
      new Notice("Private Sync: server encryption disabled for this note.", 5000);
    } catch (error) {
      new Notice(`Private Sync: cannot disable note auto-encryption: ${errorMessage(error)}`, 10000);
    }
  }

  private async renderEncryptedFragmentsInPreview(element: HTMLElement): Promise<void> {
    const nodes: CharacterData[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (parent?.closest(".private-sync-encrypted-fragment")) return NodeFilter.FILTER_REJECT;
        return findEncryptedFragments(node.nodeValue ?? "").length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode as CharacterData);

    for (const node of nodes) {
      const text = node.nodeValue ?? "";
      const fragments = findEncryptedFragments(text);
      if (fragments.length === 0 || !node.parentNode) continue;
      const replacement = document.createDocumentFragment();
      let cursor = 0;
      for (const fragment of fragments) {
        if (fragment.start > cursor) replacement.appendText(text.slice(cursor, fragment.start));
        replacement.appendChild(this.createEncryptedFragmentPreviewElement(fragment.marker));
        cursor = fragment.end;
      }
      if (cursor < text.length) replacement.appendText(text.slice(cursor));
      node.parentNode.replaceChild(replacement, node);
    }
  }

  private createEncryptedFragmentPreviewElement(marker: string): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "private-sync-encrypted-fragment private-sync-encrypted-fragment-preview";
    wrapper.dataset.privateSyncEncryptedMarker = marker;
    this.updateEncryptedFragmentPreviewElement(wrapper, marker);
    return wrapper;
  }

  private refreshEncryptedFragmentPreviewDisplays(): void {
    for (const wrapper of Array.from(activeDocument.querySelectorAll<HTMLElement>(".private-sync-encrypted-fragment-preview[data-private-sync-encrypted-marker]"))) {
      const marker = wrapper.dataset.privateSyncEncryptedMarker;
      if (marker) this.updateEncryptedFragmentPreviewElement(wrapper, marker);
    }
  }

  private updateEncryptedFragmentPreviewElement(wrapper: HTMLElement, marker: string): void {
    wrapper.empty();
    wrapper.removeClass("is-locked");
    wrapper.removeClass("is-error");
    wrapper.createSpan({ text: "Encrypted", cls: "private-sync-encrypted-fragment-label" });
    const body = wrapper.createSpan({ cls: "private-sync-encrypted-fragment-body" });
    if (!this.isEncryptionUnlocked()) {
      wrapper.addClass("is-locked");
      body.textContent = "Encrypted fragment";
      return;
    }

    const cached = this.getEncryptedFragmentDisplay(marker);
    if (cached?.status === "decrypted") {
      body.textContent = cached.text;
      return;
    }
    if (cached?.status === "failed") {
      wrapper.addClass("is-error");
      body.textContent = "Encrypted fragment";
      body.title = cached.message;
      return;
    }

    body.textContent = "Decrypting...";
    this.decryptEncryptedFragmentForDisplay(marker)
      .then((text) => {
        if (wrapper.dataset.privateSyncEncryptedMarker !== marker) return;
        body.textContent = text;
      })
      .catch((error) => {
        if (wrapper.dataset.privateSyncEncryptedMarker !== marker) return;
        wrapper.addClass("is-error");
        body.textContent = "Encrypted fragment";
        body.title = errorMessage(error);
      });
  }

  private updateConnectionStatus(): void {
    if (!this.statusBarItem) return;
    this.statusBarItem.empty();
    const icon = this.statusBarItem.createSpan({ cls: "private-sync-status-icon" });
    setIcon(icon, this.isOffline() ? "cloud-off" : "cloud");
    this.statusBarItem.createSpan({
      text: this.isOffline() ? "Private Sync: offline" : "Private Sync: online"
    });
    this.statusBarItem.toggleClass("is-offline", this.isOffline());
  }
}

function debounce<T extends (...args: never[]) => void | Promise<void>>(fn: T, delay: number): T {
  let timeout: number | undefined;
  return ((...args: never[]) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => void fn(...args), delay);
  }) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { value: String(error) };
}

function parseServerEvent(data: unknown): { type?: string; vault_id?: string; name?: string } {
  try {
    return JSON.parse(String(data)) as { type?: string; vault_id?: string; name?: string };
  } catch {
    return {};
  }
}

function findEncryptedMarker(editor: Editor): { text: string; from: { line: number; ch: number }; to: { line: number; ch: number } } | null {
  const selection = editor.getSelection();
  if (selection.trim()) {
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    return { text: selection, from, to };
  }

  const cursor = editor.getCursor();
  const text = editor.getValue();
  const offset = editor.posToOffset(cursor);
  const pattern = /%%private-sync-encrypted:v1:[A-Za-z0-9_-]+%%/g;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) {
      return {
        text: match[0],
        from: editor.offsetToPos(start),
        to: editor.offsetToPos(end)
      };
    }
  }
  return null;
}

class EncryptedFragmentEditModal extends Modal {
  private textarea!: HTMLTextAreaElement;
  private saveButton!: HTMLButtonElement;
  private value: string;

  constructor(
    private readonly plugin: PrivateSyncPlugin,
    initialValue: string,
    private readonly onSave: (text: string) => Promise<void>
  ) {
    super(plugin.app);
    this.value = initialValue;
  }

  onOpen(): void {
    this.titleEl.setText("Edit encrypted fragment");
    this.contentEl.empty();
    this.contentEl.addClass("private-sync-fragment-modal");

    this.contentEl.createDiv({
      text: "This text stays encrypted in the note after saving.",
      cls: "private-sync-muted"
    });

    this.textarea = this.contentEl.createEl("textarea", {
      cls: "private-sync-fragment-textarea"
    });
    this.textarea.value = this.value;
    this.textarea.oninput = () => {
      this.value = this.textarea.value;
      this.updateSubmitState();
    };

    const actions = this.contentEl.createDiv({ cls: "private-sync-modal-actions" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.type = "button";
    cancelButton.onclick = () => this.close();

    this.saveButton = actions.createEl("button", { text: "Save", cls: "mod-cta" });
    this.saveButton.type = "button";
    this.saveButton.onclick = () => void this.save();
    this.updateSubmitState();
    this.textarea.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private updateSubmitState(): void {
    if (this.saveButton) this.saveButton.disabled = this.value.length === 0;
  }

  private async save(): Promise<void> {
    if (this.value.length === 0) return;
    this.saveButton.disabled = true;
    this.saveButton.setText("Saving...");
    try {
      await this.onSave(this.value);
      this.close();
    } catch (error) {
      new Notice(`Private Sync encrypted fragment save failed: ${errorMessage(error)}`, 10000);
      this.saveButton.setText("Save");
      this.updateSubmitState();
    }
  }
}
