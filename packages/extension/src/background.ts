/// <reference types="chrome" />
import { cancelConfirmation, installConfirmations } from "./confirmations.js";
import { handleRequest } from "./dispatch.js";
import { connectHost } from "./host-connection.js";
import { installLandingGuard } from "./landing-guard.js";
import { forgetTab } from "./snap-state.js";
import { isPaused, togglePaused } from "./pause.js";

async function renderBadge(): Promise<void> {
  const paused = await isPaused();
  await chrome.action.setBadgeText({ text: paused ? "PAUSED" : "ON" });
  await chrome.action.setBadgeBackgroundColor({ color: paused ? "#b00020" : "#1a7f37" });
}

chrome.action.onClicked.addListener(() => void togglePaused());
// Single source of truth: any change to the flag (toolbar, rate-limit auto-pause) re-renders the badge.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.paused) void renderBadge();
});

chrome.runtime.onInstalled.addListener(renderBadge);
chrome.runtime.onStartup.addListener(renderBadge);
void renderBadge();
chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId));
installLandingGuard();
installConfirmations();
connectHost(handleRequest, cancelConfirmation);
