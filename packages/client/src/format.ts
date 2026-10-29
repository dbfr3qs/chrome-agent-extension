import type { ErrorCode, ToolName } from "@bb/protocol";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Page-controlled strings must not be able to close or spoof the untrusted wrapper. */
const neutralise = (s: string) => s.replace(/<(\/?)untrusted_page_content/gi, "‹$1untrusted_page_content");
const oneLine = (s: string) => neutralise(s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠﻿]+/g, " ").trim());

/** Tab titles and URLs come from web pages, so they are wrapped like any other page content. */
export function formatTabs(tabs: { id: number; url: string; title: string }[]): string {
  const rows = tabs.map((t) => `${t.id}\t${oneLine(t.url)}\t${oneLine(t.title)}`);
  return `<untrusted_page_content source="tabs_list">\n${rows.length ? rows.join("\n") : "(no agent tabs)"}\n</untrusted_page_content>`;
}

/** Turns a tool result into MCP-style content blocks (also used by the CLI for text). */
export function toContent(tool: ToolName, result: unknown): Content[] {
  const r = result as any;
  switch (tool) {
    case "tabs_list":
      return [{ type: "text", text: formatTabs(r) }];
    case "screenshot":
      return [{ type: "image", data: r.data, mimeType: r.mimeType }];
    case "get_text":
      return [{ type: "text", text: r.text }];
    case "wait_for":
      return [{ type: "text", text: r.found ? "found" : "timeout" }];
    default:
      if (typeof r?.snapshot === "string") return [{ type: "text", text: r.snapshot }];
      return [{ type: "text", text: JSON.stringify(result) }];
  }
}

/** What an agent should do next for each typed error. */
export const RECOVERY_HINT: Record<ErrorCode, string> = {
  POLICY_DENIED: "The user's browser policy forbids this. Do not retry or look for a workaround; tell the user what access you need.",
  USER_DENIED: "The user declined this action. Do not retry it; ask the user how to proceed.",
  CONFIRM_TIMEOUT: "The user did not answer in time, so nothing was done. Ask the user before trying again.",
  STALE_REF: "The page changed. Call snapshot again and use the new refs.",
  NOT_FOUND: "The target does not exist or the arguments were invalid. Check tabs_list and take a fresh snapshot.",
  TAB_NOT_IN_GROUP: "Only tabs in the Agent group can be used. Call tabs_list, or tab_open to create one.",
  RATE_LIMITED: "The session budget or rate limit was reached and the session is paused. Stop and tell the user.",
  PAUSED: "The user has paused agent actions. Stop and tell the user; do not retry.",
  HOST_UNAVAILABLE: "The browser bridge is not reachable. Chrome must be running with the Browser Bridge extension enabled. Tell the user.",
};
