/// <reference types="chrome" />
export interface Counters {
  actionTimes: number[];
  sessionActions: number;
}

export async function loadCounters(): Promise<Counters> {
  const { actionTimes, sessionActions } = await chrome.storage.session.get(["actionTimes", "sessionActions"]);
  return { actionTimes: Array.isArray(actionTimes) ? actionTimes : [], sessionActions: Number(sessionActions) || 0 };
}

export async function recordAction(now: number): Promise<void> {
  const c = await loadCounters();
  await chrome.storage.session.set({
    actionTimes: [...c.actionTimes.filter((t) => now - t < 60_000), now],
    sessionActions: c.sessionActions + 1,
  });
}
