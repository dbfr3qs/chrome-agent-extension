/// <reference types="chrome" />
const HOST_NAME = "com.browser_bridge.host";
const BACKOFF_MS = [500, 1000, 2000, 5000, 10000, 30000];

export type HostStatus = { connected: boolean; lastPongAt?: number; lastError?: string };
type RequestHandler = (msg: unknown) => Promise<unknown | undefined>;

let port: chrome.runtime.Port | undefined;
let attempt = 0;
let nextId = 1;
let onRequest: RequestHandler;
let onCancel: ((id: string) => void) | undefined;

async function setStatus(patch: Partial<HostStatus>): Promise<void> {
  const { hostStatus } = await chrome.storage.local.get("hostStatus");
  await chrome.storage.local.set({ hostStatus: { ...(hostStatus ?? {}), ...patch } });
}

/** Fire-and-forget message to the host (no reply expected). Dropped if disconnected. */
export function notifyHost(msg: unknown): void {
  try {
    port?.postMessage(msg);
  } catch {}
}

export function connectHost(handler?: RequestHandler, cancelHandler?: (id: string) => void): void {
  if (handler) onRequest = handler;
  if (cancelHandler) onCancel = cancelHandler;
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    return scheduleReconnect(String(e));
  }
  port.onMessage.addListener(async (msg) => {
    if (msg?.method === "cancel") {
      onCancel?.(String(msg.params?.id));
      return;
    }
    if (msg?.method) {
      const res = await onRequest(msg);
      if (res) port?.postMessage(res);
      return;
    }
    if (msg?.result?.pong) {
      attempt = 0;
      void setStatus({ connected: true, lastPongAt: Date.now(), lastError: undefined });
      console.log("[bb] pong from host", msg.result);
    }
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message ?? "disconnected";
    port = undefined;
    scheduleReconnect(err);
  });
  port.postMessage({ jsonrpc: "2.0", id: `ping-${nextId++}`, method: "ping" });
}

function scheduleReconnect(reason: string): void {
  void setStatus({ connected: false, lastError: reason });
  const delay = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]!;
  console.warn(`[bb] host unavailable (${reason}); retry in ${delay}ms`);
  setTimeout(() => connectHost(), delay);
}
