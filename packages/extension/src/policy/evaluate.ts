import { TOOLS, type ErrorCode, type ToolName } from "@bb/protocol";
import { findSite, matchUrl, parseHttpUrl } from "./match.js";
import type { Mode, Policy, Site } from "./schema.js";

export interface PolicyRequest {
  tool: ToolName;
  args: Record<string, unknown>;
  /** Present for tools that take a tabId. */
  tab?: { id: number; url: string; inGroup: boolean };
  /** Facts the content script reports about the ref'd element. */
  element?: { blocked?: boolean; submits?: boolean; href?: string; label?: string; form?: unknown };
}

export interface PolicyState {
  paused: boolean;
  now: number;
  /** Timestamps (ms) of actions allowed so far. */
  actionTimes: number[];
  sessionActions: number;
}

export type Decision =
  | { kind: "allow"; site?: string; rewriteUrl?: string }
  | { kind: "confirm"; site: string; reason: string }
  | { kind: "deny"; code: ErrorCode; reason: string; rule?: string; site?: string; pause?: boolean };

const RANK: Record<Mode, number> = { off: 0, read: 1, interact: 2, write: 3 };

const deny = (code: ErrorCode, reason: string, rule?: string, extra: { site?: string; pause?: boolean } = {}): Decision => ({
  kind: "deny",
  code,
  reason,
  rule,
  ...extra,
});

type Target = { url: URL; site: Site };

/** Resolves a URL to an allowlisted (mode >= read) site, or explains why not. */
function resolveTarget(raw: string | undefined, policy: Policy): Target | Decision {
  const url = parseHttpUrl(raw);
  if (!url) return deny("POLICY_DENIED", "only plain http(s) URLs without credentials are allowed", "scheme");
  const site = findSite(policy, url);
  if (!site || site.mode === "off") return deny("POLICY_DENIED", `no allow rule for ${url.origin}`, "default:off");
  return { url, site };
}

const isDecision = (r: Target | Decision): r is Decision => "kind" in r;

function stripQuery(url: URL, allow: string[] = []): string | undefined {
  const out = new URL(url.href);
  const keep = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (allow.includes(k)) keep.append(k, v);
  out.search = keep.toString();
  return out.href === url.href ? undefined : out.href;
}

export function evaluate(req: PolicyRequest, policy: Policy, state: PolicyState): Decision {
  if (state.paused) return deny("PAUSED", "agent actions are paused");

  const { actionsPerMinute, actionsPerSession } = policy.limits;
  if (state.actionTimes.filter((t) => state.now - t < 60_000).length >= actionsPerMinute)
    return deny("RATE_LIMITED", `more than ${actionsPerMinute} actions in a minute`, "limits.actionsPerMinute", { pause: true });
  if (state.sessionActions >= actionsPerSession)
    return deny("RATE_LIMITED", `session budget of ${actionsPerSession} actions used`, "limits.actionsPerSession", { pause: true });

  if (req.tool === "tabs_list") return { kind: "allow" };

  if (req.tool === "tab_open") {
    const t = resolveTarget(req.args.url as string, policy);
    if (isDecision(t)) return t;
    if (t.site.navigation === "patterns" && !t.site.patterns!.some((p) => matchUrl(p, t.url)))
      return deny("POLICY_DENIED", `${t.url.href} is outside the site's navigation patterns`, t.site.match, { site: t.site.match });
    return { kind: "allow", site: t.site.match, rewriteUrl: stripQuery(t.url, t.site.allowQuery) };
  }

  // Everything else acts on an existing tab.
  if (!req.tab?.inGroup) return deny("TAB_NOT_IN_GROUP", "tab is not in the Agent group");
  if (req.tool === "tab_close") return { kind: "allow" };

  const here = parseHttpUrl(req.tab.url);
  const site = here && findSite(policy, here);
  if (!here || !site || site.mode === "off")
    return deny("POLICY_DENIED", `no allow rule for ${here?.origin ?? "this page"}`, "default:off");

  let cls = TOOLS[req.tool].class;
  if (req.element?.submits && (req.tool === "click" || req.tool === "press_key")) cls = "write";
  const needed = RANK[cls === "navigate" ? "read" : cls];
  if (RANK[site.mode] < needed)
    return deny("POLICY_DENIED", `${req.tool} is a ${cls} action; ${here.origin} is in ${site.mode} mode`, site.match, { site: site.match });

  if (req.element?.blocked)
    return deny("POLICY_DENIED", "element matches a blocked selector", "blockedSelectors", { site: site.match });

  // Clicking or pressing Enter on a link navigates, so it needs the same clearance as follow_link.
  if ((req.tool === "click" || req.tool === "press_key") && req.element?.href !== undefined) {
    const t = resolveTarget(req.element.href, policy);
    if (isDecision(t)) return t;
  }

  if (req.tool === "navigate") {
    if (site.navigation !== "patterns")
      return deny("POLICY_DENIED", "this site is links-only; use follow_link", site.match, { site: site.match });
    const t = resolveTarget(req.args.url as string, policy);
    if (isDecision(t)) return t;
    if (!site.patterns!.some((p) => matchUrl(p, t.url)))
      return deny("POLICY_DENIED", `${t.url.href} does not match the site's navigation patterns`, site.match, { site: site.match });
    return { kind: "allow", site: site.match, rewriteUrl: stripQuery(t.url, site.allowQuery) };
  }

  if (req.tool === "follow_link") {
    const t = resolveTarget(req.element?.href, policy);
    if (isDecision(t)) return t;
    return { kind: "allow", site: site.match };
  }

  if (cls === "write")
    return { kind: "confirm", site: site.match, reason: `${req.tool} would submit a form on ${here.origin}` };

  return { kind: "allow", site: site.match };
}

/** Re-check where a tab actually ended up (redirects, user-initiated moves). */
export function evaluateLanding(rawUrl: string, policy: Policy): Decision {
  const t = resolveTarget(rawUrl, policy);
  return isDecision(t) ? t : { kind: "allow", site: t.site.match };
}
