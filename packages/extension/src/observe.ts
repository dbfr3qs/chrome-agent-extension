/// <reference types="chrome" />
import { BridgeError, type ToolArgs } from "@bb/protocol";
import type { SnapshotResult, Facts } from "./content/snapshot.js";
import { evaluateLanding } from "./policy/evaluate.js";
import type { Policy } from "./policy/schema.js";
import { callPage } from "./page.js";
import { beginSnapshot, commitRefs } from "./snap-state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const unwrap = <T extends { status: string }>(r: T, ref?: string): Extract<T, { status: "ok" }> => {
  if (r.status === "ok") return r as Extract<T, { status: "ok" }>;
  if (r.status === "stale") throw new BridgeError("STALE_REF", `ref ${ref ?? ""} is no longer on the page; take a new snapshot`);
  throw new BridgeError("POLICY_DENIED", "element matches a blocked selector", "blockedSelectors");
};

export type ElementFacts = { blocked: boolean; submits: boolean; href?: string; label: string; form?: unknown };

const toFacts = (f: Facts, what: string): ElementFacts => {
  if (f.status === "stale") throw new BridgeError("STALE_REF", `${what} is no longer on the page; take a new snapshot`);
  return { blocked: f.blocked, submits: f.submits, href: f.href, label: f.label, form: f.form };
};

/** Element facts the policy needs before it can decide on a ref'd action. */
export async function pageFacts(tabId: number, ref: string, policy: Policy): Promise<ElementFacts> {
  return toFacts(await callPage<Facts>(tabId, "facts", { ref, blockedSelectors: policy.blockedSelectors }, policy), `ref ${ref}`);
}

/** Same, for a key press, which acts on whatever element has focus. */
export async function activeFacts(tabId: number, key: string, policy: Policy): Promise<ElementFacts> {
  return toFacts(await callPage<Facts>(tabId, "activeFacts", { key, blockedSelectors: policy.blockedSelectors }, policy), "the focused element");
}

export async function snapshot(args: { tabId: number; scope?: string; maxChars: number }, policy: Policy) {
  const { snapshotId, nextRef } = await beginSnapshot(args.tabId);
  const r = unwrap(
    await callPage<SnapshotResult>(
      args.tabId,
      "snapshot",
      { snapshotId, nextRef, maxChars: args.maxChars, scope: args.scope, blockedSelectors: policy.blockedSelectors },
      policy,
    ),
    args.scope,
  );
  await commitRefs(args.tabId, r.nextRef);
  return { snapshotId, truncated: r.truncated, snapshot: r.snapshot };
}

export async function getText(args: { tabId: number; ref: string }, policy: Policy) {
  const r = unwrap(await callPage<any>(args.tabId, "getText", { ref: args.ref, blockedSelectors: policy.blockedSelectors }, policy), args.ref);
  return { text: r.text as string };
}

export async function scroll(args: ToolArgs<"scroll">, policy: Policy) {
  unwrap(await callPage<any>(args.tabId, "scroll", { direction: args.direction, ref: args.ref }, policy), args.ref);
  await sleep(300); // let lazy content load
  return snapshot({ tabId: args.tabId, maxChars: 12000 }, policy); // TODO(step 10): diff instead of a full snapshot
}

export async function waitFor(args: { tabId: number; text?: string; ref?: string; timeoutMs: number }, policy: Policy) {
  return callPage<{ found: boolean }>(args.tabId, "waitFor", { ...args, blockedSelectors: policy.blockedSelectors }, policy);
}

/**
 * captureVisibleTab only sees the active tab, so the agent tab is briefly activated and the
 * previously active tab restored afterwards. Blocked elements are hidden during capture.
 */
export async function screenshot(args: { tabId: number }, policy: Policy) {
  const tab = await chrome.tabs.get(args.tabId);
  const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  await callPage(args.tabId, "hideBlocked", policy.blockedSelectors, policy);
  try {
    if (!tab.active) await chrome.tabs.update(args.tabId, { active: true });
    await sleep(200);
    const now = await chrome.tabs.get(args.tabId);
    const landing = evaluateLanding(now.url ?? "", policy);
    if (landing.kind === "deny") throw new BridgeError("POLICY_DENIED", landing.reason, landing.rule);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return { mimeType: "image/png", data: dataUrl.replace(/^data:image\/png;base64,/, "") };
  } finally {
    await callPage(args.tabId, "restoreBlocked", null, policy).catch(() => {});
    if (previous?.id !== undefined && previous.id !== args.tabId) await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
  }
}
