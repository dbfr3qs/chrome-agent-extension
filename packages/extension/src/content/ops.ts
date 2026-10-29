import type { Page } from "./snapshot.js";

/**
 * The operations the background can invoke. Each takes the single JSON-serialisable argument
 * object that chrome.scripting passes across, and unpacks it for the Page method.
 */
export function makeOps(page: Page) {
  return {
    snapshot: (a: Parameters<Page["snapshot"]>[0]) => page.snapshot(a),
    facts: (a: { ref: string; blockedSelectors: string[] }) => page.facts(a.ref, a.blockedSelectors),
    activeFacts: (a: { key: string; blockedSelectors: string[] }) => page.activeFacts(a.key, a.blockedSelectors),
    getText: (a: { ref: string; blockedSelectors: string[] }) => page.getText(a.ref, a.blockedSelectors),
    scroll: (a: { direction: "up" | "down"; ref?: string }) => page.scroll(a.direction, a.ref),
    waitFor: (a: Parameters<Page["waitFor"]>[0]) => page.waitFor(a),
    hideBlocked: (blockedSelectors: string[]) => page.hideBlocked(blockedSelectors),
    restoreBlocked: () => page.restoreBlocked(),
    click: (a: { ref: string; blockedSelectors: string[] }) => page.click(a.ref, a.blockedSelectors),
    type: (a: { ref: string; text: string; clear: boolean; blockedSelectors: string[] }) =>
      page.type(a.ref, a.text, a.clear, a.blockedSelectors),
    select: (a: { ref: string; value: string; blockedSelectors: string[] }) => page.select(a.ref, a.value, a.blockedSelectors),
    pressKey: (a: { key: string; blockedSelectors: string[] }) => page.pressKey(a.key, a.blockedSelectors),
  };
}

export type Ops = ReturnType<typeof makeOps>;
