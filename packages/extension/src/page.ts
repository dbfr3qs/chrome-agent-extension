/// <reference types="chrome" />
import { BridgeError } from "@bb/protocol";
import { evaluateLanding } from "./policy/evaluate.js";
import type { Policy } from "./policy/schema.js";

// Serialised into the page by chrome.scripting, so it must not reference anything outside itself.
function runOp(op: string, arg: unknown) {
  const bb = (globalThis as any).__bb;
  if (!bb) return undefined;
  return Promise.resolve(bb[op](arg)).then((value: unknown) => ({ url: location.href, value }));
}

/**
 * Runs one Page operation inside the tab's isolated world. The caller must already have passed
 * the policy check for this tab; the landing URL is re-checked here to close the redirect race.
 */
export async function callPage<T>(tabId: number, op: string, arg: unknown, policy: Policy): Promise<T> {
  let res: { url: string; value: T } | undefined;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: runOp, args: [op, arg] });
    res = r?.result as typeof res;
  } catch (e) {
    throw new BridgeError("NOT_FOUND", `cannot inspect this page: ${(e as Error).message}`);
  }
  if (!res) throw new BridgeError("NOT_FOUND", "cannot inspect this page");
  const landing = evaluateLanding(res.url, policy);
  if (landing.kind === "deny") throw new BridgeError("POLICY_DENIED", `tab moved to a disallowed page: ${landing.reason}`, landing.rule);
  return res.value;
}
