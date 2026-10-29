import { z } from "zod";
import { PATTERN_RE } from "./match.js";

export const Mode = z.enum(["off", "read", "interact", "write"]);
export type Mode = z.infer<typeof Mode>;

const urlPattern = z
  .string()
  .regex(PATTERN_RE, "must look like https://host/path* (wildcards allowed only as a leading *. in the host and in the path)");

export const Site = z
  .object({
    match: urlPattern,
    mode: Mode,
    navigation: z.enum(["links-only", "patterns"]).default("links-only"),
    patterns: z.array(urlPattern).optional(),
    allowQuery: z.array(z.string()).optional(),
  })
  .refine((s) => s.navigation !== "patterns" || (s.patterns?.length ?? 0) > 0, {
    message: 'navigation "patterns" needs a non-empty patterns list',
    path: ["patterns"],
  });
export type Site = z.infer<typeof Site>;

export const PolicySchema = z.object({
  version: z.literal(1),
  /** Deny-by-default is not configurable. */
  default: z.literal("off"),
  sites: z.array(Site).default([]),
  blockedSelectors: z
    .array(z.string())
    .default(["input[type=password]", "[autocomplete^=cc-]", "input[type=file]"]),
  limits: z
    .object({
      actionsPerSession: z.number().int().positive().default(200),
      actionsPerMinute: z.number().int().positive().default(30),
    })
    .default({}),
  confirm: z.object({ timeoutSeconds: z.number().int().positive().default(60) }).default({}),
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = PolicySchema.parse({ version: 1, default: "off" });
