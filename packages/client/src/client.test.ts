import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { call } from "./index.js";

const sockPath = () => join(mkdtempSync(join(tmpdir(), "bbc-")), "s.sock");

describe("client", () => {
  it("returns results", async () => {
    const path = sockPath();
    const server = createServer((s) =>
      s.on("data", (d) => {
        const r = JSON.parse(d.toString());
        s.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: [r.method] }) + "\n");
      }),
    ).listen(path);
    await new Promise((r) => server.once("listening", r));
    expect(await call("tabs_list", {}, { socketPath: path })).toEqual(["tabs_list"]);
    server.close();
  });
  it("maps rpc errors to BridgeError", async () => {
    const path = sockPath();
    const server = createServer((s) =>
      s.on("data", (d) => {
        const r = JSON.parse(d.toString());
        s.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: r.id,
            error: { code: -32001, message: "x", data: { code: "POLICY_DENIED", reason: "nope" } },
          }) + "\n",
        );
      }),
    ).listen(path);
    await new Promise((r) => server.once("listening", r));
    await expect(call("tabs_list", {}, { socketPath: path })).rejects.toMatchObject({
      code: "POLICY_DENIED",
      reason: "nope",
    });
    server.close();
  });
  it("reports HOST_UNAVAILABLE when no socket", async () => {
    await expect(call("tabs_list", {}, { socketPath: sockPath() })).rejects.toMatchObject({
      code: "HOST_UNAVAILABLE",
    });
  });
});
