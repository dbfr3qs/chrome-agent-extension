/** Chrome native messaging framing: 4-byte native-endian (LE on supported platforms) length + UTF-8 JSON. */
export const MAX_MESSAGE_BYTES = 1024 * 1024; // Chrome's limit for host -> extension

export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  if (body.length > MAX_MESSAGE_BYTES) throw new Error(`message too large: ${body.length}`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder: feed arbitrary chunks, get whole messages back. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > 64 * MAX_MESSAGE_BYTES) throw new Error(`frame length ${len} exceeds limit`);
      if (this.buf.length < 4 + len) break;
      out.push(JSON.parse(this.buf.subarray(4, 4 + len).toString("utf8")));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}
