import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmQueue, type ConfirmDetails } from "./confirm-queue.js";

const d = (id: string): ConfirmDetails => ({ id, tool: "click", site: "s", tabUrl: "u", reason: "r", args: {} });

describe("ConfirmQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves approve and deny", async () => {
    const q = new ConfirmQueue();
    const a = q.request(d("a"), 60_000);
    const b = q.request(d("b"), 60_000);
    expect(q.respond("a", true)).toBe(true);
    expect(q.respond("b", false)).toBe(true);
    expect(await a).toBe("approve");
    expect(await b).toBe("deny");
  });
  it("times out unanswered requests", async () => {
    const q = new ConfirmQueue();
    const p = q.request(d("a"), 60_000);
    vi.advanceTimersByTime(60_001);
    expect(await p).toBe("timeout");
    expect(q.list()).toEqual([]);
  });
  it("ignores late, duplicate and unknown responses", async () => {
    const q = new ConfirmQueue();
    const p = q.request(d("a"), 1000);
    vi.advanceTimersByTime(1001);
    await p;
    expect(q.respond("a", true)).toBe(false); // too late: cannot revive a timed-out request
    expect(q.respond("nope", true)).toBe(false);
    const p2 = q.request(d("b"), 1000);
    q.respond("b", false);
    expect(q.respond("b", true)).toBe(false); // deny is final
    expect(await p2).toBe("deny");
  });
  it("cancels a pending request and refuses later answers", async () => {
    const q = new ConfirmQueue();
    const p = q.request(d("a"), 60_000);
    expect(q.cancel("a")).toBe(true);
    expect(await p).toBe("cancel");
    expect(q.respond("a", true)).toBe(false); // an approval arriving after cancel does nothing
    expect(q.list()).toEqual([]);
  });
  it("notifies on every change", () => {
    const seen: number[] = [];
    const q = new ConfirmQueue((l) => seen.push(l.length));
    void q.request(d("a"), 1000);
    void q.request(d("b"), 1000);
    q.respond("a", false);
    expect(seen).toEqual([1, 2, 1]);
  });
});
