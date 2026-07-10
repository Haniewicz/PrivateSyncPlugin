import { decryptTextFragment, encryptTextFragment } from "./crypto";

export const NOTE_AUTO_ENCRYPT_PROPERTY = "private-sync-encrypt";
export const NOTE_ENCRYPTED_PLACEHOLDER_PROPERTY = "private-sync-encrypted-placeholder";

type NoteParts = {
  prefix: string;
  body: string;
};

export async function encryptNoteBodyText(text: string, passphrase: string): Promise<string> {
  const parts = splitNote(text);
  if (!parts.body.trim()) throw new Error("The note body is empty.");
  if (isEncryptedNoteBody(text)) return text;
  return parts.prefix + (await encryptTextFragment(parts.body, passphrase));
}

export function markNoteForServerEncryption(text: string): string {
  return setAutoEncryptProperty(text, true);
}

export function unmarkNoteForServerEncryption(text: string): string {
  return setAutoEncryptProperty(text, false);
}

export async function decryptNoteBodyText(text: string, passphrase: string): Promise<string> {
  const parts = splitNote(text);
  if (!isEncryptedBody(parts.body)) throw new Error("The note body is not encrypted.");
  return parts.prefix + (await decryptTextFragment(parts.body, passphrase));
}

export function hasAutoEncryptProperty(text: string): boolean {
  const frontmatter = frontmatterContent(text);
  if (frontmatter === null) return false;
  const pattern = new RegExp(`^${escapeRegExp(NOTE_AUTO_ENCRYPT_PROPERTY)}\\s*:\\s*(true|yes|1)\\s*$`, "im");
  return pattern.test(frontmatter);
}

export function setAutoEncryptProperty(text: string, enabled: boolean): string {
  const match = frontmatterMatch(text);
  if (!match) {
    return enabled ? `---\n${NOTE_AUTO_ENCRYPT_PROPERTY}: true\n---\n\n${text}` : text;
  }

  const propertyPattern = new RegExp(`^${escapeRegExp(NOTE_AUTO_ENCRYPT_PROPERTY)}\\s*:.*$`, "im");
  const frontmatter = match.content;
  const nextFrontmatter = propertyPattern.test(frontmatter)
    ? frontmatter.replace(propertyPattern, enabled ? `${NOTE_AUTO_ENCRYPT_PROPERTY}: true` : "").replace(/\n{3,}/g, "\n\n")
    : enabled
      ? `${frontmatter.trimEnd()}\n${NOTE_AUTO_ENCRYPT_PROPERTY}: true\n`
      : frontmatter;

  return `---\n${nextFrontmatter.replace(/^\n+|\n+$/g, "")}\n---${match.after}`;
}

export function isEncryptedNoteBody(text: string): boolean {
  return isEncryptedBody(splitNote(text).body);
}

export function isMarkedForServerEncryption(text: string): boolean {
  return hasAutoEncryptProperty(text);
}

export function isEncryptedPlaceholder(text: string): boolean {
  const frontmatter = frontmatterContent(text);
  if (frontmatter === null) return false;
  const pattern = new RegExp(`^${escapeRegExp(NOTE_ENCRYPTED_PLACEHOLDER_PROPERTY)}\\s*:\\s*(true|yes|1)\\s*$`, "im");
  return pattern.test(frontmatter);
}

export type EncryptedPlaceholderInfo = {
  path?: string;
  fileRevisionId?: number;
  vaultRevision?: number;
};

export function encryptedPlaceholderInfo(text: string): EncryptedPlaceholderInfo | null {
  const frontmatter = frontmatterContent(text);
  if (frontmatter === null || !isEncryptedPlaceholder(text)) return null;
  return {
    path: frontmatterStringProperty(frontmatter, "private-sync-encrypted-path"),
    fileRevisionId: frontmatterNumberProperty(frontmatter, "private-sync-encrypted-revision"),
    vaultRevision: frontmatterNumberProperty(frontmatter, "private-sync-vault-revision")
  };
}

export function encryptedPlaceholderText(input: { path: string; fileRevisionId: number; vaultRevision: number; createdAt: string }): string {
  return [
    "---",
    `${NOTE_ENCRYPTED_PLACEHOLDER_PROPERTY}: true`,
    "private-sync-encrypted-path: " + JSON.stringify(input.path),
    `private-sync-encrypted-revision: ${input.fileRevisionId}`,
    `private-sync-vault-revision: ${input.vaultRevision}`,
    "private-sync-encrypted-at: " + JSON.stringify(input.createdAt),
    "---",
    "",
    "This note is encrypted on the Private Sync server.",
    "",
    "Unlock Private Sync encryption to download and replace this placeholder with the decrypted note."
  ].join("\n");
}

function splitNote(text: string): NoteParts {
  const match = frontmatterMatch(text);
  if (!match) return { prefix: "", body: text };
  return {
    prefix: text.slice(0, match.bodyStart),
    body: text.slice(match.bodyStart)
  };
}

function isEncryptedBody(body: string): boolean {
  return /^%%private-sync-encrypted:v1:[A-Za-z0-9_-]+%%$/.test(body.trim());
}

function frontmatterContent(text: string): string | null {
  return frontmatterMatch(text)?.content ?? null;
}

function frontmatterStringProperty(frontmatter: string, property: string): string | undefined {
  const pattern = new RegExp(`^${escapeRegExp(property)}\\s*:\\s*(.+?)\\s*$`, "im");
  const value = frontmatter.match(pattern)?.[1]?.trim();
  if (!value) return undefined;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function frontmatterNumberProperty(frontmatter: string, property: string): number | undefined {
  const value = frontmatter.match(new RegExp(`^${escapeRegExp(property)}\\s*:\\s*(\\d+)\\s*$`, "im"))?.[1];
  return value ? Number(value) : undefined;
}

function frontmatterMatch(text: string): { content: string; bodyStart: number; after: string } | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match || match.index !== 0) return null;
  const bodyStart = match[0].length;
  return {
    content: match[1],
    bodyStart,
    after: text.slice(match.index + match[0].length - match[2].length)
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
