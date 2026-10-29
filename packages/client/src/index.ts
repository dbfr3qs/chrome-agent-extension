import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BridgeError,
  ErrorCode,
  RpcResponse,
  type ToolArgs,
  type ToolName,
} from "@bb/protocol";

// Keep in sync with packages/host main.ts.
export const defaultSocketPath = () =>
  join(process.env.BROWSER_BRIDGE_DIR ?? join(homedir(), ".browser-bridge"), "bridge.sock");

export interface CallOptions {
  socketPath?: string;
  timeoutMs?: number;
}

/** One request per connection: simple, and no shared state to corrupt. */
export function call<N extends ToolName>(
  method: N,
  params: ToolArgs<N>,
  { socketPath = defaultSocketPath(), timeoutMs = 120_000 /* longer than a human confirmation (default 60 s) */ }: CallOptions = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `c${process.pid}-${Date.now()}`;
    let buf = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const sock = netConnect(socketPath, () =>
      sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"),
    );
    const timer = setTimeout(
      () => finish(() => reject(new BridgeError("HOST_UNAVAILABLE", `no response after ${timeoutMs}ms`))),
      timeoutMs,
    );
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const parsed = RpcResponse.safeParse(JSON.parse(buf.slice(0, nl)));
      if (!parsed.success) return finish(() => reject(new BridgeError("HOST_UNAVAILABLE", "malformed response")));
      const res = parsed.data;
      if ("error" in res) {
        const { code, reason, rule } = res.error.data;
        return finish(() => reject(new BridgeError(ErrorCode.parse(code), reason, rule)));
      }
      finish(() => resolve(res.result));
    });
    sock.on("error", (e: NodeJS.ErrnoException) =>
      finish(() => reject(new BridgeError("HOST_UNAVAILABLE", `cannot reach host socket (${e.code ?? e.message})`))),
    );
    sock.on("close", () => finish(() => reject(new BridgeError("HOST_UNAVAILABLE", "connection closed"))));
  });
}
export * from "./format.js";
