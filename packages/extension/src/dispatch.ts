/// <reference types="chrome" />
import {
  BridgeError,
  RpcRequest,
  TOOLS,
  isToolName,
  rpcFail,
  rpcOk,
  type AuditEntry,
  type RpcResponse,
  type ToolName,
} from "@bb/protocol";
import { loadCounters, recordAction } from "./action-counter.js";
import * as act from "./act.js";
import { agentTabs, findAgentGroup, openInAgentGroup } from "./agent-group.js";
import { audit, summariseArgs } from "./audit.js";
import { requestConfirmation } from "./confirmations.js";
import * as observe from "./observe.js";
import { evaluate, type Decision, type PolicyRequest } from "./policy/evaluate.js";
import type { Policy } from "./policy/schema.js";
import { loadPolicy } from "./policy/store.js";
import { isPaused, setPaused } from "./pause.js";

type Ctx = { decision: Exclude<Decision, { kind: "deny" }>; policy: Policy; element?: PolicyRequest["element"] };
type Handler = (args: any, ctx: Ctx) => Promise<unknown>;

const handlers: Partial<Record<ToolName, Handler>> = {
  tabs_list: async () =>
    (await agentTabs()).map((t) => ({ id: t.id, url: t.url ?? t.pendingUrl ?? "", title: t.title ?? "" })),
  tab_open: async (a: { url: string }, { decision }) => ({
    tabId: await openInAgentGroup(("rewriteUrl" in decision && decision.rewriteUrl) || a.url),
  }),
  tab_close: async (a: { tabId: number }) => {
    await chrome.tabs.remove(a.tabId);
    return { ok: true };
  },
  snapshot: (a, { policy }) => observe.snapshot(a, policy),
  get_text: (a, { policy }) => observe.getText(a, policy),
  scroll: (a, { policy }) => observe.scroll(a, policy),
  wait_for: (a, { policy }) => observe.waitFor(a, policy),
  screenshot: (a, { policy }) => observe.screenshot(a, policy),
  click: (a, { policy }) => act.click(a, policy),
  type: (a, { policy }) => act.type(a, policy),
  select: (a, { policy }) => act.select(a, policy),
  press_key: (a, { policy }) => act.pressKey(a, policy),
  follow_link: (a, { policy, element }) => act.navigateTo(a.tabId, element!.href!, policy),
  navigate: (a, { decision, policy }) => act.navigateTo(a.tabId, ("rewriteUrl" in decision && decision.rewriteUrl) || a.url, policy),
  back: (a, { policy }) => act.back(a.tabId, policy),
};

/** The ref an action targets, if any (snapshot uses `scope`). */
const refOf = (args: Record<string, unknown>): string | undefined =>
  typeof args.ref === "string" ? args.ref : typeof args.scope === "string" ? args.scope : undefined;

async function tabInfo(args: Record<string, unknown>): Promise<PolicyRequest["tab"]> {
  if (typeof args.tabId !== "number") return undefined;
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(args.tabId);
  } catch {
    throw new BridgeError("NOT_FOUND", `no tab ${args.tabId}`);
  }
  const groupId = await findAgentGroup();
  return { id: args.tabId, url: tab.url ?? tab.pendingUrl ?? "", inGroup: groupId !== undefined && tab.groupId === groupId };
}

/** What the page says about the element an action targets (key presses target the focused element). */
function factsFor(method: ToolName, a: Record<string, unknown>, tab: NonNullable<PolicyRequest["tab"]>, policy: Policy) {
  if (method === "press_key") return observe.activeFacts(tab.id, a.key as string, policy);
  const ref = refOf(a);
  return ref === undefined ? Promise.resolve(undefined) : observe.pageFacts(tab.id, ref, policy);
}

// Evaluate + count atomically so concurrent requests can't both slip under a limit.
let gate: Promise<unknown> = Promise.resolve();
const serialised = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = gate.then(fn, fn);
  gate = run.catch(() => {});
  return run;
};

export async function handleRequest(raw: unknown): Promise<RpcResponse | undefined> {
  const parsed = RpcRequest.safeParse(raw);
  if (!parsed.success) return undefined;
  const { id, method, params } = parsed.data;

  const entry: AuditEntry = { ts: Date.now(), id, tool: method, args: summariseArgs(params ?? {}), decision: "deny", outcome: "skipped" };
  let executing = false;

  try {
    if (!isToolName(method)) throw new BridgeError("NOT_FOUND", `unknown method ${method}`);
    const parsedArgs = TOOLS[method].args.safeParse(params ?? {});
    if (!parsedArgs.success) throw new BridgeError("NOT_FOUND", `invalid arguments: ${parsedArgs.error.message}`);
    const a = parsedArgs.data as Record<string, unknown>;

    const prep = await serialised(async () => {
      const [policy, counters, paused, tab] = await Promise.all([loadPolicy(), loadCounters(), isPaused(), tabInfo(a)]);
      const now = Date.now();
      const pstate = { paused, now, ...counters };
      entry.tabId = tab?.id;

      let element: PolicyRequest["element"];
      const needsPage = tab !== undefined && (method === "press_key" || refOf(a) !== undefined);
      if (needsPage) {
        // Inspecting a tab needs the same clearance as a snapshot; only then may our script run in it.
        const gateDecision = evaluate({ tool: "snapshot", args: {}, tab }, policy, pstate);
        if (gateDecision.kind === "deny") return { decision: gateDecision, policy, tab };
        try {
          element = await factsFor(method, a, tab, policy);
        } catch (e) {
          entry.decision = "allow";
          entry.approver = "policy";
          throw e;
        }
      }
      const decision = evaluate({ tool: method, args: a, tab, element }, policy, pstate);
      if (decision.kind !== "deny") await recordAction(now);
      if (decision.kind === "deny" && decision.pause) await setPaused(true);
      return { decision, policy, tab, element };
    });

    const { decision, policy, tab, element } = prep;
    entry.site = decision.kind === "deny" ? decision.site : decision.site;

    if (decision.kind === "deny") {
      entry.code = decision.code;
      entry.reason = decision.reason;
      entry.rule = decision.rule;
      entry.approver = "policy";
      throw new BridgeError(decision.code, decision.reason, decision.rule);
    }

    if (decision.kind === "confirm") {
      entry.decision = "confirm";
      entry.reason = decision.reason;
      const outcome = await requestConfirmation(
        {
          id: String(id),
          tool: method,
          site: decision.site,
          tabUrl: tab?.url ?? "",
          label: element?.label,
          reason: decision.reason,
          args: summariseArgs(a),
          form: element?.form as any,
        },
        policy.confirm.timeoutSeconds,
      );
      if (outcome === "timeout") throw new BridgeError("CONFIRM_TIMEOUT", `no answer within ${policy.confirm.timeoutSeconds}s`);
      if (outcome === "cancel") throw new BridgeError("USER_DENIED", "the caller disconnected; request cancelled");
      entry.approver = "user";
      if (outcome === "deny") throw new BridgeError("USER_DENIED", "you denied this action");
      // The user approved what they were shown. Make sure that is still what is on the page.
      if (await isPaused()) throw new BridgeError("PAUSED", "paused while waiting for confirmation");
      const again = tab && (await factsFor(method, a, tab, policy));
      if (JSON.stringify([again?.label, again?.form]) !== JSON.stringify([element?.label, element?.form]))
        throw new BridgeError("STALE_REF", "the page changed while waiting for your approval; nothing was done");
    } else {
      entry.decision = "allow";
      entry.approver = "policy";
    }

    if ("rewriteUrl" in decision && decision.rewriteUrl) entry.reason = `url rewritten to ${decision.rewriteUrl}`;
    const handler = handlers[method];
    if (!handler) throw new BridgeError("NOT_FOUND", `${method} is not implemented yet`);
    executing = true;
    const result = await handler(a, { decision, policy, element });
    entry.outcome = "ok";
    entry.result = JSON.stringify(result).slice(0, 200);
    return rpcOk(id, result);
  } catch (e) {
    const err = e instanceof BridgeError ? e : new BridgeError("HOST_UNAVAILABLE", String(e));
    if (executing || entry.decision === "allow") entry.outcome = "error";
    entry.code ??= err.code;
    entry.reason ??= err.reason;
    return rpcFail(id, err);
  } finally {
    audit(entry);
  }
}
