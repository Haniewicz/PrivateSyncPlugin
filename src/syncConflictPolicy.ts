import type { PendingOperation } from "./types";

export function shouldPreferServerForCreateCollision(
  operation: Pick<PendingOperation, "type" | "baseRevisionId">
): boolean {
  return operation.type === "create" && operation.baseRevisionId === null;
}
