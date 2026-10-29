import { describe, expect, it } from "vitest";
import { FrameDecoder, encodeFrame } from "./framing.js";

describe("framing", () => {
  it("round-trips a message", () => {
    expect(new FrameDecoder().push(encodeFrame({ a: 1 }))).toEqual([{ a: 1 }]);
  });
  it("reassembles split chunks and multiple frames", () => {
    const d = new FrameDecoder();
    const bytes = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2, s: "é" })]);
    const got = [...d.push(bytes.subarray(0, 3)), ...d.push(bytes.subarray(3, 10)), ...d.push(bytes.subarray(10))];
    expect(got).toEqual([{ n: 1 }, { n: 2, s: "é" }]);
  });
  it("rejects absurd lengths", () => {
    const h = Buffer.alloc(4);
    h.writeUInt32LE(0xffffffff, 0);
    expect(() => new FrameDecoder().push(h)).toThrow();
  });
});
