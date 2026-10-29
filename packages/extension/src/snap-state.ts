/// <reference types="chrome" />
/** Per-tab snapshot and ref counters. Monotonic, so a ref minted on an earlier page can never match a later one. */
interface SnapState {
  snapshots: number;
  nextRef: number;
}
const key = (tabId: number) => `snap:${tabId}`;

export async function beginSnapshot(tabId: number): Promise<{ snapshotId: string; nextRef: number }> {
  const s: SnapState = (await chrome.storage.session.get(key(tabId)))[key(tabId)] ?? { snapshots: 0, nextRef: 1 };
  s.snapshots += 1;
  await chrome.storage.session.set({ [key(tabId)]: s });
  return { snapshotId: `s${s.snapshots}`, nextRef: s.nextRef };
}

export async function commitRefs(tabId: number, nextRef: number): Promise<void> {
  const s: SnapState = (await chrome.storage.session.get(key(tabId)))[key(tabId)] ?? { snapshots: 0, nextRef: 1 };
  s.nextRef = Math.max(s.nextRef, nextRef);
  await chrome.storage.session.set({ [key(tabId)]: s });
}

export const forgetTab = (tabId: number) => chrome.storage.session.remove(key(tabId));
