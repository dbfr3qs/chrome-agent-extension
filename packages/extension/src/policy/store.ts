/// <reference types="chrome" />
import { DEFAULT_POLICY, PolicySchema, type Policy } from "./schema.js";

/** Fail closed: a missing or invalid stored policy is the deny-all default. */
export async function loadPolicy(): Promise<Policy> {
  const { policy } = await chrome.storage.local.get("policy");
  const parsed = PolicySchema.safeParse(policy);
  return parsed.success ? parsed.data : DEFAULT_POLICY;
}

export async function savePolicy(policy: Policy): Promise<void> {
  await chrome.storage.local.set({ policy });
}
