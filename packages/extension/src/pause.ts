/// <reference types="chrome" />
const PAUSED_KEY = "paused";

/** Fail-closed: anything but an explicit `false` counts as paused. */
export async function isPaused(): Promise<boolean> {
  const { [PAUSED_KEY]: paused } = await chrome.storage.local.get(PAUSED_KEY);
  return paused !== false;
}

export async function setPaused(paused: boolean): Promise<void> {
  // Resuming starts a fresh session budget.
  if (!paused) await chrome.storage.session.set({ actionTimes: [], sessionActions: 0 });
  await chrome.storage.local.set({ [PAUSED_KEY]: paused });
}

export async function togglePaused(): Promise<void> {
  await setPaused(!(await isPaused()));
}
