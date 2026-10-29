import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuditEntry, RpcRequest, RpcResponse } from "@bb/protocol";
import { Bridge } from "./bridge.js";
import { FrameDecoder, encodeFrame } from "./framing.js";
import { startSocketServer } from "./server.js";

// Keep in sync with packages/client defaultSocketPath().
const DATA_DIR = process.env.BROWSER_BRIDGE_DIR ?? join(homedir(), ".browser-bridge");
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
// stdout is the native-messaging channel; diagnostics must go to a file.
const log = (line: string) => appendFileSync(join(DATA_DIR, "host.log"), `${new Date().toISOString()} ${line}\n`);

const send = (msg: unknown) => process.stdout.write(encodeFrame(msg));
const bridge = new Bridge(send);

const auditPath = join(DATA_DIR, "audit.jsonl");

function handle(raw: unknown): void {
  const m = raw as { method?: string; id?: unknown; params?: { entry?: unknown } };
  if (m?.method === "audit" && m.id === undefined) {
    const entry = AuditEntry.safeParse(m.params?.entry);
    if (entry.success) appendFileSync(auditPath, JSON.stringify(entry.data) + "\n", { mode: 0o600 });
    else log(`bad audit entry: ${entry.error.message.slice(0, 200)}`);
    return;
  }
  const res = RpcResponse.safeParse(raw);
  if (res.success && !("method" in (raw as object))) return bridge.fromExtension(res.data);

  const req = RpcRequest.safeParse(raw);
  if (!req.success) {
    log(`ignored malformed message: ${JSON.stringify(raw).slice(0, 200)}`);
    return;
  }
  if (req.data.method === "ping") {
    log(`ping id=${req.data.id}`);
    send({ jsonrpc: "2.0", id: req.data.id, result: { pong: true, ts: Date.now(), pid: process.pid } });
    return;
  }
  log(`unhandled method ${req.data.method}`);
}

const decoder = new FrameDecoder();
process.stdin.on("data", (chunk) => {
  try {
    decoder.push(chunk).forEach(handle);
  } catch (e) {
    log(`decode error: ${(e as Error).message}`);
    process.exit(1);
  }
});
process.stdin.on("end", () => {
  log("stdin closed, exiting");
  bridge.failAll();
  process.exit(0);
});

const socketPath = join(DATA_DIR, "bridge.sock");
startSocketServer(socketPath, bridge).then(
  () => log(`host started pid=${process.pid} socket=${socketPath}`),
  (e) => log(`socket error: ${e.message}`),
);
