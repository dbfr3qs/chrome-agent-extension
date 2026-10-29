/// <reference types="chrome" />
import { ConfirmQueue, type ConfirmDetails, type Outcome } from "./confirm-queue.js";

const PANEL_URL = () => chrome.runtime.getURL("sidepanel.html");
let panelPorts = 0;
let popupWindowId: number | undefined;

const queue = new ConfirmQueue((pending) => {
  void chrome.storage.session.set({ pending });
  if (pending.length > 0) void ensureVisible();
  else void closePopup();
});

/** Chrome only opens the side panel from a user gesture, so fall back to a popup of the same page. */
async function ensureVisible(): Promise<void> {
  if (panelPorts > 0 || popupWindowId !== undefined) return;
  try {
    const w = await chrome.windows.create({ url: PANEL_URL(), type: "popup", width: 480, height: 660, focused: true });
    popupWindowId = w.id;
  } catch {}
}

async function closePopup(): Promise<void> {
  const id = popupWindowId;
  popupWindowId = undefined;
  if (id !== undefined) await chrome.windows.remove(id).catch(() => {});
}

export function requestConfirmation(details: ConfirmDetails, timeoutSeconds: number): Promise<Outcome> {
  return queue.request(details, timeoutSeconds * 1000);
}

export const cancelConfirmation = (id: string) => queue.cancel(id);

export function installConfirmations(): void {
  void chrome.storage.session.set({ pending: [] }); // in-flight promises do not survive a worker restart
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "panel" || port.sender?.id !== chrome.runtime.id) return;
    panelPorts++;
    port.onDisconnect.addListener(() => {
      panelPorts = Math.max(0, panelPorts - 1);
    });
  });
  chrome.windows.onRemoved.addListener((id) => {
    if (id === popupWindowId) popupWindowId = undefined;
  });
  // Only our own panel page may answer. Page scripts cannot forge sender.url, and the agent cannot
  // open chrome-extension:// pages, so it cannot press its own approve button.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== "confirm-response" || typeof msg.id !== "string") return;
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(PANEL_URL())) return;
    queue.respond(msg.id, msg.approve === true);
  });
}
