import { z } from "zod";
import { BridgeErrorData } from "./errors.js";
import { TOOL_NAMES, type ToolName } from "./tools.js";

const id = z.union([z.string(), z.number()]);

export const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id,
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export const RpcResponse = z.union([
  // error first: `result: z.unknown()` also matches a missing key
  z.object({
    jsonrpc: z.literal("2.0"),
    id,
    error: z.object({ code: z.number(), message: z.string(), data: BridgeErrorData }),
  }),
  z.object({ jsonrpc: z.literal("2.0"), id, result: z.unknown() }),
]);
export type RpcResponse = z.infer<typeof RpcResponse>;

export const isToolName = (m: string): m is ToolName => (TOOL_NAMES as string[]).includes(m);

import { BridgeError, RPC_ERROR_NUMBER } from "./errors.js";

export const rpcOk = (id: string | number, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });

export const rpcFail = (id: string | number, err: BridgeError): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: {
    code: RPC_ERROR_NUMBER[err.code],
    message: err.message,
    data: { code: err.code, reason: err.reason, rule: err.rule },
  },
});
