export async function sha256(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Text(text: string): Promise<string> {
  return sha256(new TextEncoder().encode(text).buffer);
}

export function uuid(): string {
  return crypto.randomUUID();
}

const ENCRYPTION_PREFIX = "private-sync-encrypted:v1";
const KEY_DERIVATION_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

type EncryptionKind = "bytes" | "fragment" | "key-check";

type EncryptionEnvelope = {
  v: 1;
  kind: EncryptionKind;
  kdf: "PBKDF2-SHA-256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

export function isEncryptedPayload(value: string): boolean {
  return value.startsWith(`${ENCRYPTION_PREFIX}:`);
}

export async function encryptBytes(content: ArrayBuffer, passphrase: string): Promise<ArrayBuffer> {
  const envelope = await encryptEnvelope(content, passphrase, "bytes");
  return new TextEncoder().encode(`${ENCRYPTION_PREFIX}:${base64UrlEncodeUtf8(JSON.stringify(envelope))}`).buffer;
}

export async function decryptBytes(content: ArrayBuffer, passphrase: string): Promise<ArrayBuffer> {
  const text = new TextDecoder().decode(content);
  const envelope = parseEnvelope(text, "bytes");
  return decryptEnvelope(envelope, passphrase);
}

export async function createEncryptionKeyCheck(passphrase: string): Promise<string> {
  const envelope = await encryptEnvelope(new TextEncoder().encode("private-sync-key-check").buffer, passphrase, "key-check");
  return `${ENCRYPTION_PREFIX}:${base64UrlEncodeUtf8(JSON.stringify(envelope))}`;
}

export async function verifyEncryptionKeyCheck(keyCheck: string, passphrase: string): Promise<boolean> {
  try {
    const envelope = parseEnvelope(keyCheck, "key-check");
    const decrypted = await decryptEnvelope(envelope, passphrase);
    return new TextDecoder().decode(decrypted) === "private-sync-key-check";
  } catch {
    return false;
  }
}

export async function encryptTextFragment(text: string, passphrase: string): Promise<string> {
  const envelope = await encryptEnvelope(new TextEncoder().encode(text).buffer, passphrase, "fragment");
  return `%%${ENCRYPTION_PREFIX}:${base64UrlEncodeUtf8(JSON.stringify(envelope))}%%`;
}

export async function decryptTextFragment(marker: string, passphrase: string): Promise<string> {
  const trimmed = marker.trim();
  const inner = trimmed.startsWith("%%") && trimmed.endsWith("%%") ? trimmed.slice(2, -2) : trimmed;
  const envelope = parseEnvelope(inner, "fragment");
  const decrypted = await decryptEnvelope(envelope, passphrase);
  return new TextDecoder().decode(decrypted);
}

async function encryptEnvelope(content: ArrayBuffer, passphrase: string, kind: EncryptionKind): Promise<EncryptionEnvelope> {
  if (!passphrase) throw new Error("Encryption passphrase is required.");
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, content);
  return {
    v: 1,
    kind,
    kdf: "PBKDF2-SHA-256",
    iterations: KEY_DERIVATION_ITERATIONS,
    salt: base64UrlEncode(salt),
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext))
  };
}

async function decryptEnvelope(envelope: EncryptionEnvelope, passphrase: string): Promise<ArrayBuffer> {
  if (!passphrase) throw new Error("Encryption passphrase is required.");
  const salt = base64UrlDecode(envelope.salt);
  const iv = base64UrlDecode(envelope.iv);
  const key = await deriveKey(passphrase, salt);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(base64UrlDecode(envelope.ciphertext)));
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      iterations: KEY_DERIVATION_ITERATIONS
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function parseEnvelope(payload: string, expectedKind: EncryptionKind): EncryptionEnvelope {
  if (!isEncryptedPayload(payload)) throw new Error("Not a Private Sync encrypted payload.");
  const encoded = payload.slice(ENCRYPTION_PREFIX.length + 1);
  const envelope = JSON.parse(base64UrlDecodeUtf8(encoded)) as Partial<EncryptionEnvelope>;
  if (
    envelope.v !== 1 ||
    envelope.kind !== expectedKind ||
    envelope.kdf !== "PBKDF2-SHA-256" ||
    envelope.iterations !== KEY_DERIVATION_ITERATIONS ||
    typeof envelope.salt !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("Unsupported Private Sync encrypted payload.");
  }
  return envelope as EncryptionEnvelope;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64UrlEncodeUtf8(value: string): string {
  return base64UrlEncode(new TextEncoder().encode(value));
}

function base64UrlDecodeUtf8(value: string): string {
  return new TextDecoder().decode(base64UrlDecode(value));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
