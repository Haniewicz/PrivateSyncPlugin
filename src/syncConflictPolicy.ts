import type { PendingOperation } from "./types";

export function shouldPreferServerForCreateCollision(
  operation: Pick<PendingOperation, "type" | "baseRevisionId" | "contentHash" | "plaintextHash">,
  currentLocalHash: string
): boolean {
  const uploadedPlaintextHash = operation.plaintextHash ?? operation.contentHash;
  return operation.type === "create" && operation.baseRevisionId === null && uploadedPlaintextHash === currentLocalHash;
}
