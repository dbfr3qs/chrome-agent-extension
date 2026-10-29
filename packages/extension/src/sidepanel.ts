/// <reference types="chrome" />
import type { PendingView } from "./confirm-queue.js";

// Everything here comes from pages the agent visited, so only textContent is ever used, never innerHTML.
const pendingEl = document.getElementById("pending")!;
const auditEl = document.getElementById("audit")!;
const stateEl = document.getElementById("state")!;

chrome.runtime.connect({ name: "panel" }); // lets the background know the panel is open

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const row = (k: string, v: string) => {
  const r = el("div", undefined, "row");
  r.append(el("span", k, "k"), el("span", v, "v"));
  return r;
};

function renderPending(list: PendingView[]): void {
  pendingEl.replaceChildren();
  if (!list.length) pendingEl.append(el("p", "Nothing waiting for approval.", "muted"));
  for (const p of list) {
    const card = el("section", undefined, "card");
    card.append(el("h3", `${p.tool} on ${p.site}`));
    card.append(row("Page", p.tabUrl), row("Element", p.label ?? "(none)"), row("Why", p.reason));
    for (const [k, v] of Object.entries(p.args)) card.append(row(k, String(v)));
    if (p.form) {
      card.append(row("Form posts to", `${p.form.method.toUpperCase()} ${p.form.action}`));
      for (const f of p.form.fields) card.append(row(`  field ${f.name}`, f.value));
    }
    const left = el("span", "", "muted");
    const tick = () => (left.textContent = `auto-denies in ${Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 1000))}s`);
    tick();
    setInterval(tick, 500);
    const buttons = el("div", undefined, "buttons");
    const answer = (approve: boolean) => {
      void chrome.runtime.sendMessage({ type: "confirm-response", id: p.id, approve });
      buttons.querySelectorAll("button").forEach((b) => (b.disabled = true));
    };
    const approve = el("button", "Approve", "approve");
    const deny = el("button", "Deny", "deny");
    approve.addEventListener("click", () => answer(true));
    deny.addEventListener("click", () => answer(false));
    buttons.append(deny, approve, left);
    card.append(buttons);
    pendingEl.append(card);
  }
}

function renderAudit(log: any[]): void {
  auditEl.replaceChildren();
  for (const e of log.slice(-30).reverse()) {
    const line = el("div", undefined, `audit ${e.decision}`);
    const t = new Date(e.ts).toLocaleTimeString();
    line.textContent = `${t}  ${e.decision.toUpperCase()}  ${e.tool}${e.code ? " " + e.code : ""}  ${e.site ?? ""}  ${e.reason ?? ""}`;
    auditEl.append(line);
  }
}

async function renderState(): Promise<void> {
  const { paused } = await chrome.storage.local.get("paused");
  const { sessionActions = 0 } = await chrome.storage.session.get("sessionActions");
  stateEl.textContent = `${paused === false ? "ON" : "PAUSED"} · ${sessionActions} actions this session`;
}

async function refresh(): Promise<void> {
  const [{ pending = [] }, { audit = [] }] = await Promise.all([chrome.storage.session.get("pending"), chrome.storage.local.get("audit")]);
  renderPending(pending);
  renderAudit(audit);
  await renderState();
}

chrome.storage.onChanged.addListener(() => void refresh());
void refresh();
