/// <reference types="chrome" />
import { BridgeError, type ToolArgs } from "@bb/protocol";
import type { ActionResult } from "./content/snapshot.js";
import { callPage } from "./page.js";
import * as observe from "./observe.js";
import type { Policy } from "./policy/schema.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function unwrap(r: ActionResult, ref?: string): void {
  if (r.status === "ok") return;
  if (r.status === "stale") throw new BridgeError("STALE_REF", `ref ${ref ?? ""} is no longer on the page; take a new snapshot`);
  if (r.status === "error") throw new BridgeError("NOT_FOUND", r.message);
  throw new BridgeError("POLICY_DENIED", "element matches a blocked selector", "blockedSelectors");
}

/**
 * Runs `trigger`, then waits for the tab to finish loading. Rejects if the tab disappears, which is
 * what the landing guard does to a tab that ends up somewhere the policy disallows.
 */
function waitForNavigation(tabId: number, trigger: () => Promise<unknown>, maxMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    let sawLoading = false;
    const finish = (err?: BridgeError) => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(overall);
      clearTimeout(noStart);
      err ? reject(err) : resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      else if (info.status === "complete" && sawLoading) finish();
    };
    const onRemoved = (id: number) => {
      if (id === tabId) finish(new BridgeError("POLICY_DENIED", TAB_CLOSED));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    const overall = setTimeout(() => finish(), maxMs);
    const noStart = setTimeout(() => !sawLoading && finish(), 2000); // e.g. same-document navigation
    trigger().catch((e) => finish(new BridgeError("NOT_FOUND", String(e?.message ?? e))));
  });
}

const TAB_CLOSED = "tab was closed: it landed on a page the policy disallows";

/**
 * Snapshot after a navigation. If the tab vanished in between, the landing guard closed it
 * (the page committed just before the guard ran), so report the policy outcome, not "no such tab".
 */
async function snapshotAfterNavigation(tabId: number, policy: Policy) {
  try {
    return await observe.snapshot({ tabId, maxChars: 12000 }, policy);
  } catch (e) {
    const gone = await chrome.tabs.get(tabId).then(() => false, () => true);
    if (gone) throw new BridgeError("POLICY_DENIED", TAB_CLOSED);
    throw e;
  }
}

/** After an action, give the page a moment to react, wait out any navigation, and return what it looks like now. */
async function settle(tabId: number, policy: Policy) {
  await sleep(300);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "loading") await waitForNavigation(tabId, async () => {}, 10000);
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    throw new BridgeError("POLICY_DENIED", TAB_CLOSED);
  }
  return snapshotAfterNavigation(tabId, policy);
}

export async function click(a: ToolArgs<"click">, policy: Policy) {
  unwrap(await callPage<ActionResult>(a.tabId, "click", { ref: a.ref, blockedSelectors: policy.blockedSelectors }, policy), a.ref);
  return settle(a.tabId, policy);
}

export async function type(a: ToolArgs<"type">, policy: Policy) {
  unwrap(
    await callPage<ActionResult>(a.tabId, "type", { ref: a.ref, text: a.text, clear: a.clear ?? false, blockedSelectors: policy.blockedSelectors }, policy),
    a.ref,
  );
  return { ok: true };
}

export async function select(a: ToolArgs<"select">, policy: Policy) {
  unwrap(await callPage<ActionResult>(a.tabId, "select", { ref: a.ref, value: a.value, blockedSelectors: policy.blockedSelectors }, policy), a.ref);
  return { ok: true };
}

export async function pressKey(a: ToolArgs<"press_key">, policy: Policy) {
  unwrap(await callPage<ActionResult>(a.tabId, "pressKey", { key: a.key, blockedSelectors: policy.blockedSelectors }, policy));
  return settle(a.tabId, policy);
}

/** Navigation is done by the extension (not by clicking), so page script cannot redirect it. */
export async function navigateTo(tabId: number, url: string, policy: Policy) {
  await waitForNavigation(tabId, () => chrome.tabs.update(tabId, { url }));
  return snapshotAfterNavigation(tabId, policy);
}

export async function back(tabId: number, policy: Policy) {
  await waitForNavigation(tabId, () => chrome.tabs.goBack(tabId));
  return snapshotAfterNavigation(tabId, policy);
}
