import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";
import type { Bridge } from "./bridge.js";

/** Unix socket, user-only (0600). Newline-delimited JSON-RPC. */
export function startSocketServer(path: string, bridge: Bridge): Promise<Server> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    unlinkSync(path); // stale socket from a previous host
  } catch {}
  const server = createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        bridge.fromClient(socket, buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    socket.on("close", () => bridge.clientGone(socket));
    socket.on("error", () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      chmodSync(path, 0o600);
      resolve(server);
    });
  });
}
