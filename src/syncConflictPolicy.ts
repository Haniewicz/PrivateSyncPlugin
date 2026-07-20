import type { PendingOperation } from "./types";

export function canAutoResolveCreateConflict(
  operation: Pick<PendingOperation, "type" | "baseRevisionId">,
  localContent: ArrayBuffer,
  serverContent: ArrayBuffer
): boolean {
  if (operation.type !== "create" || operation.baseRevisionId !== null) return false;
  if (localContent.byteLength !== serverContent.byteLength) return false;

  const local = new Uint8Array(localContent);
  const server = new Uint8Array(serverContent);
  for (let index = 0; index < local.length; index += 1) {
    if (local[index] !== server[index]) return false;
  }
  return true;
}

export function shouldPreferServerForEmptyCreate(
  operation: Pick<PendingOperation, "type" | "baseRevisionId">,
  localContent: ArrayBuffer,
  serverContent: ArrayBuffer
): boolean {
  if (operation.type !== "create" || operation.baseRevisionId !== null) return false;
  return isBlankText(localContent) && !isBlankText(serverContent);
}

function isBlankText(content: ArrayBuffer): boolean {
  return new TextDecoder().decode(content).trim().length === 0;
}
