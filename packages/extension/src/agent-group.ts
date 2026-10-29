/// <reference types="chrome" />
const GROUP_KEY = "agentGroupId";
const GROUP_TITLE = "Agent";
const GROUP_COLOR = "purple";

/**
 * Returns the Agent group id. The id is cached in session storage, which is wiped when the
 * extension reloads, so fall back to the group this extension created (title "Agent", purple).
 */
export async function findAgentGroup(): Promise<number | undefined> {
  const { [GROUP_KEY]: id } = await chrome.storage.session.get(GROUP_KEY);
  if (typeof id === "number") {
    try {
      await chrome.tabGroups.get(id);
      return id;
    } catch {}
  }
  const [found] = await chrome.tabGroups.query({ title: GROUP_TITLE, color: GROUP_COLOR });
  if (found) await chrome.storage.session.set({ [GROUP_KEY]: found.id });
  return found?.id;
}

export async function agentTabs(): Promise<chrome.tabs.Tab[]> {
  const groupId = await findAgentGroup();
  return groupId === undefined ? [] : chrome.tabs.query({ groupId });
}

/**
 * Opens a tab inside the Agent group. The tab starts blank and is grouped *before* it
 * navigates, so every redirect lands in a tab the landing guard can see.
 */
export async function openInAgentGroup(url: string): Promise<number> {
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const existing = await findAgentGroup();
  const groupId = await chrome.tabs.group(
    existing === undefined ? { tabIds: tab.id! } : { tabIds: tab.id!, groupId: existing },
  );
  if (existing === undefined) {
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
    await chrome.storage.session.set({ [GROUP_KEY]: groupId });
  }
  await chrome.tabs.update(tab.id!, { url });
  return tab.id!;
}
