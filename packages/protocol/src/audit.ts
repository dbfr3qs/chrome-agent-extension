import { z } from "zod";
import { ErrorCode } from "./errors.js";

export const AuditEntry = z.object({
  ts: z.number(),
  id: z.union([z.string(), z.number()]),
  tool: z.string(),
  args: z.record(z.unknown()).default({}),
  tabId: z.number().optional(),
  site: z.string().optional(),
  decision: z.enum(["allow", "confirm", "deny"]),
  code: ErrorCode.optional(),
  reason: z.string().optional(),
  rule: z.string().optional(),
  approver: z.enum(["policy", "user"]).optional(),
  outcome: z.enum(["ok", "error", "skipped"]),
  result: z.string().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
