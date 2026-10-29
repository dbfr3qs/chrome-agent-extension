/// <reference types="chrome" />
import type { AuditEntry } from "@bb/protocol";
import { notifyHost } from "./host-connection.js";

const RING_SIZE = 500;
let chain: Promise<void> = Promise.resolve(); // serialise read-modify-write

/** Appends to the ring buffer shown in the side panel and forwards to the host's JSONL file. */
export function audit(entry: AuditEntry): void {
  notifyHost({ jsonrpc: "2.0", method: "audit", params: { entry } });
  chain = chain
    .then(async () => {
      const { audit: log = [] } = await chrome.storage.local.get("audit");
      await chrome.storage.local.set({ audit: [...log, entry].slice(-RING_SIZE) });
    })
    .catch(() => {});
}

const trunc = (v: unknown) => (typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v);
export const summariseArgs = (args: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(args).map(([k, v]) => [k, trunc(v)]));
