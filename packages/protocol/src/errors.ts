import { z } from "zod";

export const ERROR_CODES = [
  "POLICY_DENIED",
  "USER_DENIED",
  "CONFIRM_TIMEOUT",
  "STALE_REF",
  "NOT_FOUND",
  "TAB_NOT_IN_GROUP",
  "RATE_LIMITED",
  "PAUSED",
  "HOST_UNAVAILABLE",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** JSON-RPC server-error range (-32000..-32099), one slot per typed code. */
export const RPC_ERROR_NUMBER: Record<ErrorCode, number> = Object.fromEntries(
  ERROR_CODES.map((c, i) => [c, -32001 - i]),
) as Record<ErrorCode, number>;

export const BridgeErrorData = z.object({
  code: ErrorCode,
  reason: z.string().optional(),
  rule: z.string().optional(),
});
export type BridgeErrorData = z.infer<typeof BridgeErrorData>;

export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly reason?: string,
    readonly rule?: string,
  ) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = "BridgeError";
  }
}
