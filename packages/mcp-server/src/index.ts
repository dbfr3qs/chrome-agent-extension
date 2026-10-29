import { call } from "@bb/client";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// stdout is the MCP channel; anything we print for humans goes to stderr.
await createServer((tool, args) => call(tool, args)).connect(new StdioServerTransport());
console.error("browser-bridge MCP server ready");
