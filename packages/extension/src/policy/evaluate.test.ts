import { describe, expect, it } from "vitest";
import { evaluate, evaluateLanding, type PolicyRequest, type PolicyState } from "./evaluate.js";
import { PolicySchema } from "./schema.js";

const P = PolicySchema.parse({
  version: 1,
  default: "off",
  sites: [
    { match: "https://docs.example.com/*", mode: "read" },
    { match: "https://app.example.com/*", mode: "interact" },
    {
      match: "http://localhost:5173/*",
      mode: "write",
      navigation: "patterns",
      patterns: ["http://localhost:5173/*"],
      allowQuery: ["page", "q"],
    },
    { match: "https://*.wiki.test/*", mode: "read" },
  ],
  limits: { actionsPerMinute: 3, actionsPerSession: 5 },
});

const state = (o: Partial<PolicyState> = {}): PolicyState => ({ paused: false, now: 1_000_000, actionTimes: [], sessionActions: 0, ...o });
const tab = (url: string, inGroup = true) => ({ id: 1, url, inGroup });
const req = (r: Partial<PolicyRequest> & Pick<PolicyRequest, "tool">): PolicyRequest => ({ args: {}, ...r });
const DOCS = "https://docs.example.com/page";
const APP = "https://app.example.com/x";
const LOCAL = "http://localhost:5173/";

describe("kill switch and limits", () => {
  it("denies everything when paused", () => {
    expect(evaluate(req({ tool: "tabs_list" }), P, state({ paused: true }))).toMatchObject({ kind: "deny", code: "PAUSED" });
  });
  it("rate limits per minute and asks to pause", () => {
    const times = [999_000, 999_500, 999_900];
    expect(evaluate(req({ tool: "tabs_list" }), P, state({ actionTimes: times }))).toMatchObject({
      code: "RATE_LIMITED",
      pause: true,
    });
  });
  it("ignores actions older than a minute", () => {
    expect(evaluate(req({ tool: "tabs_list" }), P, state({ actionTimes: [1, 2, 3] })).kind).toBe("allow");
  });
  it("enforces the session budget", () => {
    expect(evaluate(req({ tool: "tabs_list" }), P, state({ sessionActions: 5 }))).toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("tab_open", () => {
  const open = (url: string) => evaluate(req({ tool: "tab_open", args: { url } }), P, state());
  it("denies unlisted sites (deny by default)", () => {
    expect(open("https://example.org/")).toMatchObject({ kind: "deny", code: "POLICY_DENIED" });
  });
  it("allows a listed site", () => {
    expect(open(DOCS).kind).toBe("allow");
  });
  it("strips query parameters that are not allowlisted", () => {
    expect(open("https://docs.example.com/a?secret=1")).toMatchObject({ kind: "allow", rewriteUrl: "https://docs.example.com/a" });
    expect(open("http://localhost:5173/?q=hi&token=x")).toMatchObject({ rewriteUrl: "http://localhost:5173/?q=hi" });
  });
  it.each(["chrome://settings", "chrome-extension://abc/options.html", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi"])(
    "never targets %s",
    (url) => expect(open(url)).toMatchObject({ kind: "deny", code: "POLICY_DENIED" }),
  );
  it("rejects credential and suffix tricks", () => {
    expect(open("https://docs.example.com@evil.test/").kind).toBe("deny");
    expect(open("https://docs.example.com.evil.test/").kind).toBe("deny");
    expect(open("http://docs.example.com/").kind).toBe("deny"); // scheme must match
    expect(open("https://docs.example.com:8443/").kind).toBe("deny"); // port must match
  });
  it("handles wildcard subdomains", () => {
    expect(open("https://a.b.wiki.test/").kind).toBe("allow");
    expect(open("https://wiki.test/").kind).toBe("deny");
  });
});

describe("modes", () => {
  const act = (tool: PolicyRequest["tool"], url: string, extra: Partial<PolicyRequest> = {}) =>
    evaluate(req({ tool, tab: tab(url), args: {}, ...extra }), P, state());

  it("rejects tabs outside the Agent group", () => {
    expect(evaluate(req({ tool: "snapshot", tab: tab(DOCS, false) }), P, state())).toMatchObject({ code: "TAB_NOT_IN_GROUP" });
  });
  it("lets the agent close its own tab even on an unlisted page", () => {
    expect(evaluate(req({ tool: "tab_close", tab: tab("https://evil.test/") }), P, state()).kind).toBe("allow");
  });
  it("denies pages with no rule", () => {
    expect(act("snapshot", "https://evil.test/")).toMatchObject({ kind: "deny", rule: "default:off" });
    expect(act("snapshot", "about:blank").kind).toBe("deny");
  });
  it("read mode: observe yes, interact no", () => {
    for (const t of ["snapshot", "get_text", "scroll", "screenshot", "wait_for"] as const) expect(act(t, DOCS).kind).toBe("allow");
    expect(act("click", DOCS)).toMatchObject({ kind: "deny", code: "POLICY_DENIED" });
    expect(act("type", DOCS).kind).toBe("deny");
  });
  it("interact mode: click/type/select yes, submit no", () => {
    for (const t of ["click", "type", "select", "press_key"] as const) expect(act(t, APP).kind).toBe("allow");
    expect(act("click", APP, { element: { submits: true } })).toMatchObject({ kind: "deny", code: "POLICY_DENIED" });
    expect(act("press_key", APP, { element: { submits: true } }).kind).toBe("deny");
  });
  it("write mode: submit needs confirmation, plain typing does not", () => {
    expect(act("click", LOCAL, { element: { submits: true } })).toMatchObject({ kind: "confirm" });
    expect(act("type", LOCAL).kind).toBe("allow");
  });
  it("blocked elements are untouchable in every mode", () => {
    expect(act("type", LOCAL, { element: { blocked: true } })).toMatchObject({ kind: "deny", rule: "blockedSelectors" });
    expect(act("get_text", DOCS, { element: { blocked: true } }).kind).toBe("deny");
  });
});

describe("navigation", () => {
  const nav = (tool: PolicyRequest["tool"], from: string, extra: Partial<PolicyRequest>) =>
    evaluate(req({ tool, tab: tab(from), ...extra }), P, state());

  it("links-only sites cannot navigate(url)", () => {
    expect(nav("navigate", DOCS, { args: { url: "https://docs.example.com/other" } })).toMatchObject({ kind: "deny" });
  });
  it("follow_link goes only to allowlisted targets", () => {
    expect(nav("follow_link", DOCS, { element: { href: "https://docs.example.com/next" } }).kind).toBe("allow");
    expect(nav("follow_link", DOCS, { element: { href: "https://attacker.test/?d=secret" } })).toMatchObject({ kind: "deny" });
    expect(nav("follow_link", DOCS, {}).kind).toBe("deny"); // no href reported: fail closed
  });
  it("patterns sites allow matching URLs and strip other query params", () => {
    const d = nav("navigate", LOCAL, { args: { url: "http://localhost:5173/list?page=2&d=leak" } });
    expect(d).toMatchObject({ kind: "allow", rewriteUrl: "http://localhost:5173/list?page=2" });
  });
  it("patterns sites deny URLs outside the patterns, even if allowlisted elsewhere", () => {
    expect(nav("navigate", LOCAL, { args: { url: "https://docs.example.com/" } })).toMatchObject({ kind: "deny" });
    expect(nav("navigate", LOCAL, { args: { url: "https://attacker.test/" } })).toMatchObject({ kind: "deny" });
  });
});

describe("clicking links", () => {
  const click = (href: string, from = APP) =>
    evaluate(req({ tool: "click", tab: tab(from), element: { href } }), P, state());
  it("allows a click on a link to an allowlisted page", () => {
    expect(click("https://docs.example.com/x").kind).toBe("allow");
  });
  it("cannot be used to bypass links-only: unlisted targets are denied", () => {
    expect(click("https://attacker.test/?d=secret")).toMatchObject({ kind: "deny", code: "POLICY_DENIED" });
    expect(click("javascript:alert(1)").kind).toBe("deny");
    expect(click("chrome-extension://abc/options.html").kind).toBe("deny");
  });
  it("applies to Enter on a focused link too", () => {
    expect(evaluate(req({ tool: "press_key", tab: tab(APP), element: { href: "https://attacker.test/" } }), P, state()).kind).toBe("deny");
  });
});

describe("evaluateLanding (redirects)", () => {
  it("accepts allowlisted landings", () => expect(evaluateLanding(DOCS, P).kind).toBe("allow"));
  it("rejects unlisted or non-http landings", () => {
    expect(evaluateLanding("https://evil.test/", P).kind).toBe("deny");
    expect(evaluateLanding("chrome-extension://x/options.html", P).kind).toBe("deny");
  });
});

describe("policy schema", () => {
  it("refuses a non-off default", () => {
    expect(PolicySchema.safeParse({ version: 1, default: "read" }).success).toBe(false);
  });
  it("refuses host wildcards that could match attacker domains", () => {
    expect(PolicySchema.safeParse({ version: 1, default: "off", sites: [{ match: "https://example.com*", mode: "read" }] }).success).toBe(false);
    expect(PolicySchema.safeParse({ version: 1, default: "off", sites: [{ match: "https://*example.com/*", mode: "read" }] }).success).toBe(false);
  });
  it("requires patterns when navigation is patterns", () => {
    expect(PolicySchema.safeParse({ version: 1, default: "off", sites: [{ match: "https://a.test/*", mode: "read", navigation: "patterns" }] }).success).toBe(false);
  });
  it("fills in default blocked selectors and limits", () => {
    const p = PolicySchema.parse({ version: 1, default: "off" });
    expect(p.blockedSelectors).toContain("input[type=password]");
    expect(p.limits).toEqual({ actionsPerSession: 200, actionsPerMinute: 30 });
  });
});
