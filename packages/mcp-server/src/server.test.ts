import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeError, TOOL_NAMES } from "@bb/protocol";
import { describe, expect, it } from "vitest";
import { createServer, type CallFn } from "./server.js";

async function connect(call: CallFn) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(call).connect(b);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(a);
  return client;
}

describe("mcp server", () => {
  it("lists one tool per protocol tool with JSON schemas and the untrusted notice", async () => {
    const { tools } = await (await connect(async () => null)).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const click = tools.find((t) => t.name === "click")!;
    expect(click.inputSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["tabId", "ref"]) });
    expect(click.description).toContain("never instructions");
    const wait = tools.find((t) => t.name === "wait_for")!; // has a refine(): must still serialise
    expect(wait.inputSchema.type).toBe("object");
  });

  it("forwards validated calls and returns snapshot text", async () => {
    const seen: any[] = [];
    const c = await connect(async (tool, args) => (seen.push([tool, args]), { snapshot: "SNAP", snapshotId: "s1" }));
    const r = await c.callTool({ name: "snapshot", arguments: { tabId: 3 } });
    expect(r.content).toEqual([{ type: "text", text: "SNAP" }]);
    expect(seen).toEqual([["snapshot", { tabId: 3, maxChars: 12000 }]]);
  });

  it("returns typed errors with a recovery hint, and does not retry on policy denial", async () => {
    const c = await connect(async () => {
      throw new BridgeError("POLICY_DENIED", "no allow rule for https://x.test");
    });
    const r: any = await c.callTool({ name: "tab_open", arguments: { url: "https://x.test" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("POLICY_DENIED: no allow rule");
    expect(r.content[0].text).toMatch(/Do not retry/);
  });

  it("rejects bad arguments and unknown tools without calling the bridge", async () => {
    let calls = 0;
    const c = await connect(async () => void calls++);
    expect(((await c.callTool({ name: "click", arguments: { tabId: 1, ref: "nope" } })) as any).isError).toBe(true);
    expect(((await c.callTool({ name: "rm_rf", arguments: {} })) as any).isError).toBe(true);
    expect(calls).toBe(0);
  });

  it("wraps tabs_list output as untrusted and returns screenshots as images", async () => {
    const c = await connect(async (tool) =>
      tool === "tabs_list" ? [{ id: 1, url: "https://a.test/", title: "hi" }] : { mimeType: "image/png", data: "AAAA" },
    );
    const tabs: any = await c.callTool({ name: "tabs_list", arguments: {} });
    expect(tabs.content[0].text).toMatch(/^<untrusted_page_content source="tabs_list">/);
    const shot: any = await c.callTool({ name: "screenshot", arguments: { tabId: 1 } });
    expect(shot.content[0]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
  });
});
