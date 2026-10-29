// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { makeOps } from "./ops.js";
import { Page } from "./snapshot.js";

const BLOCKED = ["input[type=password]", "[autocomplete^=cc-]", "input[type=file]"];
let ops: ReturnType<typeof makeOps>;
const events: string[] = [];

const load = (html: string) => {
  document.body.innerHTML = html;
  events.length = 0;
  ops = makeOps(new Page(document));
};
/** Takes a snapshot and returns the ref shown for the first line matching `re`. */
const refFor = (re: RegExp): string => {
  const r = ops.snapshot({ snapshotId: "s1", nextRef: 1, maxChars: 12000, blockedSelectors: BLOCKED }) as { snapshot: string };
  const m = r.snapshot.split("\n").find((l) => re.test(l));
  const ref = m && /\[(e\d+)\]/.exec(m)?.[1];
  if (!ref) throw new Error(`no ref for ${re}\n${r.snapshot}`);
  return ref;
};
// Mirrors how the background invokes ops: one JSON-ish argument object.
const call = <K extends keyof typeof ops>(op: K, arg: Parameters<(typeof ops)[K]>[0]) => (ops[op] as (a: unknown) => unknown)(arg);

describe("ops use the argument shapes the background sends", () => {
  beforeEach(() =>
    load(`<main><a id="l" href="/x">Link</a><button id="b">Plain</button>
      <form id="f" action="/save" method="post"><label for="n">Note</label><input id="n" name="note">
      <input type="password" name="pw" value="hunter2"><select id="s" name="color"><option value="r">Red</option><option value="g">Green</option></select>
      <button id="go">Save</button></form></main>`),
  );

  it("facts / getText / scroll", () => {
    const ref = refFor(/link "Link"/);
    expect(call("facts", { ref, blockedSelectors: BLOCKED })).toMatchObject({ status: "ok", blocked: false, submits: false });
    expect(call("getText", { ref, blockedSelectors: BLOCKED })).toMatchObject({ status: "ok" });
    document.defaultView!.scrollBy = () => {};
    expect(call("scroll", { direction: "down" })).toEqual({ status: "ok" });
    expect(call("scroll", { direction: "down", ref: "e999" })).toEqual({ status: "stale" });
  });

  it("click fires a click and reports stale/blocked/disabled", () => {
    document.getElementById("b")!.addEventListener("click", () => events.push("clicked"));
    const ref = refFor(/button "Plain"/);
    expect(call("click", { ref, blockedSelectors: BLOCKED })).toEqual({ status: "ok" });
    expect(events).toEqual(["clicked"]);
    expect(call("click", { ref: "e999", blockedSelectors: BLOCKED })).toEqual({ status: "stale" });
    (document.getElementById("b") as HTMLButtonElement).disabled = true;
    expect(call("click", { ref, blockedSelectors: BLOCKED })).toMatchObject({ status: "error" });
  });

  it("type uses input+change events, supports clear, and refuses non-text and blocked fields", () => {
    const n = document.getElementById("n") as HTMLInputElement;
    n.addEventListener("input", () => events.push("input"));
    n.addEventListener("change", () => events.push("change"));
    const ref = refFor(/textbox "Note"/);
    call("type", { ref, text: "hello", clear: false, blockedSelectors: BLOCKED });
    call("type", { ref, text: " world", clear: false, blockedSelectors: BLOCKED });
    expect(n.value).toBe("hello world");
    call("type", { ref, text: "new", clear: true, blockedSelectors: BLOCKED });
    expect(n.value).toBe("new");
    expect(events).toEqual(["input", "change", "input", "change", "input", "change"]);
    const btn = refFor(/button "Plain"/);
    expect(call("type", { ref: btn, text: "x", clear: false, blockedSelectors: BLOCKED })).toMatchObject({ status: "error" });
  });

  it("type cannot reach a password field even with its ref guessed", () => {
    refFor(/textbox "Note"/);
    // password has no ref; also verify the content-side guard with an explicit selector match
    const pw = document.querySelector<HTMLInputElement>("input[type=password]")!;
    const page = new Page(document);
    page.snapshot({ snapshotId: "s", nextRef: 1, maxChars: 9999, blockedSelectors: [] }); // policy list empty: still redacted
    expect(page.resolve("e1")).not.toBe(pw);
    expect(pw.value).toBe("hunter2");
  });

  it("select picks by value or visible text and rejects unknown options", () => {
    const ref = refFor(/combobox "/);
    expect(call("select", { ref, value: "Green", blockedSelectors: BLOCKED })).toEqual({ status: "ok" });
    expect((document.getElementById("s") as HTMLSelectElement).value).toBe("g");
    expect(call("select", { ref, value: "Blue", blockedSelectors: BLOCKED })).toMatchObject({ status: "error" });
  });

  it("describes a submit button with its form, redacting password values", () => {
    const ref = refFor(/button "Save"/);
    const f = call("facts", { ref, blockedSelectors: BLOCKED }) as any;
    expect(f.submits).toBe(true);
    expect(f.label).toBe('button "Save"');
    expect(f.form.method).toBe("post");
    expect(f.form.action).toContain("/save");
    expect(f.form.fields).toContainEqual({ name: "pw", value: "[redacted]" });
    expect(JSON.stringify(f)).not.toContain("hunter2");
  });

  it("press_key Enter in a form text field submits (requestSubmit); activeFacts says so first", () => {
    const n = document.getElementById("n") as HTMLInputElement;
    document.getElementById("f")!.addEventListener("submit", (e) => {
      e.preventDefault();
      events.push("submit");
    });
    n.focus();
    expect(call("activeFacts", { key: "Enter", blockedSelectors: BLOCKED })).toMatchObject({ status: "ok", submits: true });
    expect(call("activeFacts", { key: "a", blockedSelectors: BLOCKED })).toMatchObject({ submits: false });
    expect(call("pressKey", { key: "Enter", blockedSelectors: BLOCKED })).toEqual({ status: "ok" });
    expect(events).toContain("submit");
  });

  it("press_key refuses when a blocked field has focus", () => {
    const pw = document.querySelector<HTMLInputElement>("input[type=password]")!;
    pw.focus();
    expect(call("activeFacts", { key: "Enter", blockedSelectors: BLOCKED })).toMatchObject({ blocked: true, submits: true });
    expect(call("pressKey", { key: "Enter", blockedSelectors: BLOCKED })).toEqual({ status: "blocked" });
  });

  it("active link + Enter reports its href for the navigation check", () => {
    document.getElementById("l")!.focus();
    expect(call("activeFacts", { key: "Enter", blockedSelectors: BLOCKED })).toMatchObject({ href: expect.stringContaining("/x") });
  });

  it("hideBlocked takes the selector array, as the background sends it", () => {
    expect(call("hideBlocked", BLOCKED)).toMatchObject({ hidden: 1 });
    expect(call("restoreBlocked", undefined as never)).toEqual({ ok: true });
  });

  it("historyBack reports an empty history, and goes back when there is one", async () => {
    expect(call("historyBack", undefined as never)).toMatchObject({ status: "error", message: expect.stringContaining("no earlier page") });
    history.pushState({}, "", "/second");
    const popped = new Promise((r) => window.addEventListener("popstate", r, { once: true }));
    expect(call("historyBack", undefined as never)).toEqual({ status: "ok" });
    await popped;
    expect(location.pathname).not.toBe("/second");
  });

  it("waitFor takes the full options object", async () => {
    expect(await call("waitFor", { text: "link", timeoutMs: 300, blockedSelectors: BLOCKED })).toEqual({ found: true });
  });
});
