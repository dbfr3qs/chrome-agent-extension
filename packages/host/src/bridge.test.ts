import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bridge } from "./bridge.js";
import { startSocketServer } from "./server.js";

const fakeConn = () => {
  const lines: string[] = [];
  return { lines, write: (l: string) => void lines.push(l) };
};

describe("Bridge", () => {
  it("remaps ids so two clients with the same id don't collide", () => {
    const sent: any[] = [];
    const b = new Bridge((m) => sent.push(m));
    const a = fakeConn();
    const c = fakeConn();
    const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tabs_list" });
    b.fromClient(a, req);
    b.fromClient(c, req);
    expect(sent.map((m) => m.id)).toEqual(["h1", "h2"]);
    b.fromExtension({ jsonrpc: "2.0", id: "h2", result: ["two"] });
    expect(a.lines).toEqual([]);
    expect(JSON.parse(c.lines[0]!)).toEqual({ jsonrpc: "2.0", id: 1, result: ["two"] });
  });
  it("fails in-flight requests with HOST_UNAVAILABLE", () => {
    const b = new Bridge(() => {});
    const a = fakeConn();
    b.fromClient(a, JSON.stringify({ jsonrpc: "2.0", id: "x", method: "tabs_list" }));
    b.failAll();
    expect(JSON.parse(a.lines[0]!).error.data.code).toBe("HOST_UNAVAILABLE");
  });
  it("tells the extension to cancel when a client disconnects mid-request", () => {
    const sent: any[] = [];
    const b = new Bridge((m) => sent.push(m));
    const a = fakeConn();
    b.fromClient(a, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "click", params: {} }));
    b.clientGone(a);
    expect(sent[1]).toEqual({ jsonrpc: "2.0", method: "cancel", params: { id: "h1" } });
    b.clientGone(a); // already cleaned up: no second cancel
    expect(sent).toHaveLength(2);
    b.fromExtension({ jsonrpc: "2.0", id: "h1", result: "late" }); // late reply is dropped
    expect(a.lines).toEqual([]);
  });
  it("serves a real unix socket with 0600 perms", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "bb-")), "s.sock");
    const b = new Bridge((m: any) => b.fromExtension({ jsonrpc: "2.0", id: m.id, result: "pong" }));
    const server = await startSocketServer(path, b);
    const reply = await new Promise<string>((resolve) => {
      const s = connect(path, () => s.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tabs_list" }) + "\n"));
      s.once("data", (d) => resolve(d.toString()));
    });
    expect(JSON.parse(reply)).toEqual({ jsonrpc: "2.0", id: 7, result: "pong" });
    expect((await import("node:fs")).statSync(path).mode & 0o777).toBe(0o600);
    server.close();
  });
});
