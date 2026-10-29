import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  RPC_ERROR_NUMBER,
  RpcRequest,
  RpcResponse,
  TOOLS,
  TOOL_NAMES,
  isToolName,
} from "./index.js";

describe("tools", () => {
  it("defines the 15 spec tools", () => {
    expect(TOOL_NAMES).toHaveLength(15);
  });
  it("applies snapshot defaults", () => {
    expect(TOOLS.snapshot.args.parse({ tabId: 1 }).maxChars).toBe(12000);
  });
  it("rejects bad refs and over-long waits", () => {
    expect(TOOLS.click.args.safeParse({ tabId: 1, ref: "abc" }).success).toBe(false);
    expect(TOOLS.wait_for.args.safeParse({ tabId: 1, text: "x", timeoutMs: 20000 }).success).toBe(false);
    expect(TOOLS.wait_for.args.safeParse({ tabId: 1 }).success).toBe(false);
  });
});

describe("rpc", () => {
  it("round-trips a request", () => {
    const req = { jsonrpc: "2.0", id: 1, method: "snapshot", params: { tabId: 3 } };
    expect(RpcRequest.parse(JSON.parse(JSON.stringify(req)))).toEqual(req);
    expect(isToolName(req.method)).toBe(true);
  });
  it("round-trips every typed error", () => {
    for (const code of ERROR_CODES) {
      const res = {
        jsonrpc: "2.0",
        id: "a",
        error: { code: RPC_ERROR_NUMBER[code], message: code, data: { code } },
      };
      expect(RpcResponse.parse(res)).toEqual(res);
    }
  });
  it("assigns unique rpc error numbers", () => {
    expect(new Set(Object.values(RPC_ERROR_NUMBER)).size).toBe(ERROR_CODES.length);
  });
});
