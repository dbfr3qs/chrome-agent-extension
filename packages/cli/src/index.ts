#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, formatTabs } from "@bb/client";
import { BridgeError } from "@bb/protocol";

const USAGE = `usage:
  bb tabs
  bb tab-open <url>
  bb tab-close <tabId>
  bb snapshot --tab <id> [--scope <ref>] [--max <chars>]
  bb text --tab <id> <ref>
  bb scroll --tab <id> <up|down> [<ref>]
  bb wait --tab <id> (--text <text> | --ref <ref>) [--timeout <ms>]
  bb screenshot --tab <id> [-o <file.png>]
  bb click --tab <id> <ref>
  bb type --tab <id> <ref> <text> [--clear]
  bb select --tab <id> <ref> <value>
  bb key --tab <id> <key>            (Enter, Escape, Tab, ...)
  bb follow --tab <id> <ref>
  bb navigate --tab <id> <url>
  bb back --tab <id>`;

const BOOLEAN_FLAGS = new Set(["clear"]);

class UsageError extends Error {}

function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--") && BOOLEAN_FLAGS.has(a.slice(2))) {
      flags[a.slice(2)] = "true";
    } else if (a.startsWith("--") || a === "-o") {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      flags[a.replace(/^-+/, "")] = v;
    } else pos.push(a);
  }
  return { pos, flags };
}

const num = (v: string | undefined, name: string): number => {
  const n = Number(v);
  if (v === undefined || !Number.isInteger(n)) throw new UsageError(`${name} must be an integer`);
  return n;
};

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parse(rest);
  const tabId = () => num(flags.tab, "--tab");

  switch (cmd) {
    case "tabs": {
      const tabs = (await call("tabs_list", {})) as { id: number; url: string; title: string }[];
      console.log(formatTabs(tabs));
      return;
    }
    case "tab-open": {
      if (!pos[0]) throw new UsageError("tab-open needs a url");
      const r = (await call("tab_open", { url: pos[0] })) as { tabId: number };
      console.log(`opened tab ${r.tabId}`);
      return;
    }
    case "tab-close": {
      await call("tab_close", { tabId: num(pos[0] ?? flags.tab, "tabId") });
      console.log("closed");
      return;
    }
    case "snapshot": {
      const r = (await call("snapshot", {
        tabId: tabId(),
        ...(flags.scope && { scope: flags.scope }),
        ...(flags.max && { maxChars: num(flags.max, "--max") }),
      })) as { snapshot: string };
      console.log(r.snapshot);
      return;
    }
    case "text": {
      if (!pos[0]) throw new UsageError("text needs a ref");
      const r = (await call("get_text", { tabId: tabId(), ref: pos[0] })) as { text: string };
      console.log(r.text);
      return;
    }
    case "scroll": {
      if (pos[0] !== "up" && pos[0] !== "down") throw new UsageError("scroll needs up or down");
      const r = (await call("scroll", { tabId: tabId(), direction: pos[0], ...(pos[1] && { ref: pos[1] }) })) as { snapshot: string };
      console.log(r.snapshot);
      return;
    }
    case "wait": {
      if (!flags.text && !flags.ref) throw new UsageError("wait needs --text or --ref");
      const r = (await call("wait_for", {
        tabId: tabId(),
        ...(flags.text && { text: flags.text }),
        ...(flags.ref && { ref: flags.ref }),
        ...(flags.timeout && { timeoutMs: num(flags.timeout, "--timeout") }),
      })) as { found: boolean };
      console.log(r.found ? "found" : "timeout");
      if (!r.found) process.exitCode = 1;
      return;
    }
    case "screenshot": {
      const r = (await call("screenshot", { tabId: tabId() })) as { data: string };
      const file = flags.o ?? join(tmpdir(), `bb-shot-${Date.now()}.png`);
      writeFileSync(file, Buffer.from(r.data, "base64"));
      console.log(file);
      return;
    }
    case "click":
    case "key":
    case "follow":
    case "navigate":
    case "back": {
      const tool = { click: "click", key: "press_key", follow: "follow_link", navigate: "navigate", back: "back" }[cmd] as
        | "click" | "press_key" | "follow_link" | "navigate" | "back";
      const need = (v: string | undefined, what: string) => {
        if (!v) throw new UsageError(`${cmd} needs ${what}`);
        return v;
      };
      const args =
        cmd === "click" || cmd === "follow" ? { tabId: tabId(), ref: need(pos[0], "a ref") }
        : cmd === "key" ? { tabId: tabId(), key: need(pos[0], "a key") }
        : cmd === "navigate" ? { tabId: tabId(), url: need(pos[0], "a url") }
        : { tabId: tabId() };
      const r = (await call(tool, args as never)) as { snapshot: string };
      console.log(r.snapshot);
      return;
    }
    case "type": {
      if (!pos[0] || pos[1] === undefined) throw new UsageError("type needs a ref and text");
      await call("type", { tabId: tabId(), ref: pos[0], text: pos[1], ...(flags.clear && { clear: true }) });
      console.log("ok");
      return;
    }
    case "select": {
      if (!pos[0] || pos[1] === undefined) throw new UsageError("select needs a ref and a value");
      await call("select", { tabId: tabId(), ref: pos[0], value: pos[1] });
      console.log("ok");
      return;
    }
    default:
      throw new UsageError(cmd ? `unknown command ${cmd}` : "no command");
  }
}

// An action that submits a form waits for a human; say so rather than hanging silently.
const waitingHint = setTimeout(
  () => console.error("(still waiting; an action that submits a form waits for your approval in the Browser Bridge window)"),
  4000,
);

main(process.argv.slice(2)).finally(() => clearTimeout(waitingHint)).catch((e) => {
  if (e instanceof UsageError) {
    console.error(`${e.message}\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(e instanceof BridgeError ? e.message : String(e?.message ?? e));
    process.exitCode = 1;
  }
});
