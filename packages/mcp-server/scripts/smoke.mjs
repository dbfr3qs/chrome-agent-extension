// Drives the built MCP server over stdio against the live bridge. Usage: node scripts/smoke.mjs [url]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const url = process.argv[2] ?? "http://localhost:5173/";
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] }));

const text = (r) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
const show = (label, r) => console.log(`\n## ${label}${r.isError ? "  (isError)" : ""}\n${text(r).split("\n").slice(0, 8).join("\n")}`);

console.log("node", process.version, "| tools:", (await client.listTools()).tools.length);
const opened = await client.callTool({ name: "tab_open", arguments: { url } });
show("tab_open", opened);
const tabId = JSON.parse(text(opened)).tabId;
await new Promise((r) => setTimeout(r, 3000));
show("tabs_list", await client.callTool({ name: "tabs_list", arguments: {} }));
show("snapshot", await client.callTool({ name: "snapshot", arguments: { tabId } }));
show("denied: tab_open attacker", await client.callTool({ name: "tab_open", arguments: { url: "http://attacker.test/?d=1" } }));
show("stale ref", await client.callTool({ name: "click", arguments: { tabId, ref: "e999" } }));
show("bad args", await client.callTool({ name: "click", arguments: { tabId, ref: "x" } }));
show("tab_close", await client.callTool({ name: "tab_close", arguments: { tabId } }));
await client.close();
