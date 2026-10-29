import { BridgeError, RpcRequest, rpcFail, type RpcResponse } from "@bb/protocol";

export interface ClientConn {
  write(line: string): void;
}

/** Multiplexes socket clients onto the single native-messaging port by request id. */
export class Bridge {
  private seq = 0;
  private pending = new Map<string, { conn: ClientConn; id: string | number }>();

  constructor(private sendNative: (msg: unknown) => void) {}

  /** One line of JSON-RPC from a socket client. */
  fromClient(conn: ClientConn, line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = RpcRequest.safeParse(raw);
    if (!parsed.success) return;
    const hostId = `h${++this.seq}`;
    this.pending.set(hostId, { conn, id: parsed.data.id });
    this.sendNative({ ...parsed.data, id: hostId });
  }

  /** A response from the extension; routes back to the originating client. */
  fromExtension(res: RpcResponse): void {
    const entry = this.pending.get(String(res.id));
    if (!entry) return;
    this.pending.delete(String(res.id));
    entry.conn.write(JSON.stringify({ ...res, id: entry.id }) + "\n");
  }

  /** A client left (timeout, ctrl-C): tell the extension to abandon its in-flight requests so nothing runs unobserved. */
  clientGone(conn: ClientConn): void {
    for (const [k, v] of this.pending) {
      if (v.conn !== conn) continue;
      this.pending.delete(k);
      this.sendNative({ jsonrpc: "2.0", method: "cancel", params: { id: k } });
    }
  }

  /** Extension disconnected: fail everything in flight. */
  failAll(): void {
    for (const [k, v] of this.pending) {
      v.conn.write(JSON.stringify(rpcFail(v.id, new BridgeError("HOST_UNAVAILABLE", "extension disconnected"))) + "\n");
      this.pending.delete(k);
    }
  }
}
