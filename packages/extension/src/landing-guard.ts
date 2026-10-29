/// <reference types="chrome" />
import { findAgentGroup } from "./agent-group.js";
import { audit } from "./audit.js";
import { evaluateLanding } from "./policy/evaluate.js";
import { loadPolicy } from "./policy/store.js";

async function enforce(tabId: number, url: string, stamp: number, phase: "committed" | "error"): Promise<void> {
  const groupId = await findAgentGroup();
  if (groupId === undefined) return;
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (tab.groupId !== groupId) return;
  const decision = evaluateLanding(url, await loadPolicy());
  if (decision.kind !== "deny") return;
  await chrome.tabs.remove(tabId).catch(() => {});
  audit({
    ts: Date.now(),
    id: `landing-${tabId}-${stamp}`,
    tool: "landing_check",
    args: { url, phase },
    tabId,
    decision: "deny",
    code: decision.code,
    reason: `tab closed: ${decision.reason}`,
    rule: decision.rule,
    approver: "policy",
    outcome: "ok",
  });
}

/**
 * Redirects and manual moves are re-checked: a disallowed landing page is closed and reported.
 * Failed loads count too, so a tab is never left parked on an unlisted URL behind an error page.
 */
export function installLandingGuard(): void {
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId === 0 && d.url !== "about:blank") void enforce(d.tabId, d.url, d.timeStamp, "committed");
  });
  chrome.webNavigation.onErrorOccurred.addListener((d) => {
    if (d.frameId === 0 && d.url !== "about:blank") void enforce(d.tabId, d.url, d.timeStamp, "error");
  });
}
