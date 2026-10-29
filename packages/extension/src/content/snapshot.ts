/** DOM walker injected into Agent-group tabs. Pure over a Document so it can run under jsdom. */

export interface SnapshotOptions {
  snapshotId: string;
  /** First unused ref number; the background keeps this monotonic per tab so refs never collide across pages. */
  nextRef: number;
  maxChars: number;
  scope?: string;
  blockedSelectors: string[];
}

export type SnapshotResult =
  | { status: "ok"; snapshot: string; truncated: boolean; nextRef: number }
  | { status: "stale" | "blocked" };

export interface FormInfo {
  action: string;
  method: string;
  fields: { name: string; value: string }[];
}

export type Facts =
  | { status: "ok"; blocked: boolean; submits: boolean; href?: string; label: string; form?: FormInfo }
  | { status: "stale" };

export type ActionResult = { status: "ok" } | { status: "stale" | "blocked" } | { status: "error"; message: string };

const NON_TEXT_INPUTS = new Set(["button", "submit", "reset", "image", "checkbox", "radio", "file", "hidden", "password", "range", "color"]);
const FOCUSABLE = "a[href],button,input,select,textarea,[tabindex]";

const ZERO_WIDTH = /[​-‏‪-‮⁠﻿]/g;
const WRAPPER_TAG = /<(\/?)untrusted_page_content/gi;

const clean = (s: string) => s.replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
/** Quote page text so it cannot close or spoof the untrusted-content wrapper. */
const neutralise = (s: string) => s.replace(WRAPPER_TAG, "‹$1untrusted_page_content");
const quote = (s: string) => neutralise(JSON.stringify(s));
const attrSafe = (s: string) => neutralise(s).replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");

const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head", "link", "meta", "iframe", "svg", "canvas", "object", "embed"]);
const LANDMARK_TAGS: Record<string, string> = { main: "main", nav: "nav", header: "banner", footer: "contentinfo", aside: "complementary", form: "form" };
const LANDMARK_ROLES: Record<string, string> = { main: "main", navigation: "nav", banner: "banner", contentinfo: "contentinfo", search: "search", complementary: "complementary", form: "form" };
const SPECIAL =
  "a[href],button,input,select,textarea,h1,h2,h3,h4,h5,h6,tr,main,nav,header,footer,aside,form," +
  "[role=button],[role=link],[role=main],[role=navigation],[role=banner],[role=contentinfo],[role=search],[role=complementary],[role=form]";
const BUTTON_INPUTS = new Set(["button", "submit", "reset", "image"]);
const MAX_TEXT_LINE = 300;

const LINK_LINE = /^\s*\[e\d+\] link ("(?:[^"\\]|\\.)*")(?: -> (.*))?$/;

/** Card layouts put a nameless image link, a heading, then a text link to the same place; keep the named one. */
function dropRedundantUnnamed(lines: string[]): string[] {
  return lines.filter((line, i) => {
    const m = LINK_LINE.exec(line);
    if (!m || m[1] !== '"(unnamed)"' || !m[2]) return true;
    for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
      const n = LINK_LINE.exec(lines[j]!);
      if (n && n[1] !== '"(unnamed)"' && n[2] === m[2]) return false;
    }
    return true;
  });
}

interface Ctx {
  counter: number;
  lines: string[];
  used: number;
  max: number;
  truncated: boolean;
}

export class Page {
  private refs = new Map<string, WeakRef<Element>>();
  private ids = new WeakMap<Element, string>();
  private sel: string[] = [];
  private maxRef = 0;
  private restoreFns: Array<() => void> = [];

  constructor(private doc: Document) {}

  private get win(): Window & typeof globalThis {
    return this.doc.defaultView as Window & typeof globalThis;
  }

  resolve(ref: string): Element | undefined {
    const el = this.refs.get(ref)?.deref();
    return el && el.isConnected ? el : undefined;
  }

  // ---- classification -------------------------------------------------------------------

  private matchesBlocked(el: Element, deep: boolean): boolean {
    if (el instanceof this.win.HTMLInputElement && el.type === "password") return true; // never optional
    return this.sel.some((s) => {
      try {
        return deep ? el.closest(s) !== null : el.matches(s);
      } catch {
        return false; // invalid selector in policy: ignore rather than crash
      }
    });
  }

  private hidden(el: Element): boolean {
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
    if (el.localName === "input" && (el as HTMLInputElement).type === "hidden") return true;
    const parent = el.parentElement;
    if (parent?.localName === "details" && !(parent as HTMLDetailsElement).open && el.localName !== "summary") return true;
    const cs = this.win.getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || cs.opacity === "0";
  }

  private skipped(el: Element): boolean {
    return SKIP_TAGS.has(el.localName) || this.hidden(el);
  }

  /** `<label for=x>` text is already the name of control x; repeating it as a text line is noise. */
  private redundantLabel(el: Element): boolean {
    if (el.localName !== "label") return false;
    const control = (el as HTMLLabelElement).control;
    return !!control && !el.contains(control);
  }

  private isInline(el: Element): boolean {
    return this.win.getComputedStyle(el).display.startsWith("inline");
  }

  // ---- text -------------------------------------------------------------------------------

  /** Visible text of a subtree: skips hidden and blocked elements. */
  private text(node: Node): string {
    if (node.nodeType === 3) return node.nodeValue ?? "";
    if (node.nodeType !== 1) return "";
    const el = node as Element;
    if (this.skipped(el) || this.matchesBlocked(el, false)) return "";
    if (el.localName === "img") return el.getAttribute("alt") ?? "";
    if (el.localName === "br") return " ";
    if (el.localName === "input" || el.localName === "textarea" || el.localName === "select") return "";
    const block = !this.isInline(el);
    let out = "";
    for (const c of Array.from(el.childNodes)) out += this.text(c);
    return block ? ` ${out} ` : out;
  }

  private name(el: Element): string {
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = labelledby
        .split(/\s+/)
        .map((id) => this.doc.getElementById(id))
        .map((e) => (e ? clean(this.text(e)) : ""))
        .join(" ");
      if (clean(t)) return trunc(clean(t), 80);
    }
    const aria = clean(el.getAttribute("aria-label") ?? "");
    if (aria) return trunc(aria, 80);
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) {
      const t = clean(Array.from(labels).map((l) => this.text(l)).join(" "));
      if (t) return trunc(t, 80);
    }
    if (el.localName === "input") {
      const i = el as HTMLInputElement;
      if (BUTTON_INPUTS.has(i.type) && i.value) return trunc(clean(i.value), 80);
      if (i.type === "image" && i.alt) return trunc(clean(i.alt), 80);
    } else {
      const t = clean(this.text(el));
      if (t) return trunc(t, 80);
    }
    return trunc(clean(el.getAttribute("title") ?? el.getAttribute("placeholder") ?? ""), 80);
  }

  // ---- refs ---------------------------------------------------------------------------------

  private refFor(el: Element, ctx: Ctx): string {
    let ref = this.ids.get(el);
    if (!ref) {
      ref = `e${ctx.counter++}`;
      this.maxRef = Math.max(this.maxRef, ctx.counter - 1);
      this.ids.set(el, ref);
      this.refs.set(ref, new WeakRef(el));
    }
    return ref;
  }

  // ---- snapshot ----------------------------------------------------------------------------

  private emit(ctx: Ctx, depth: number, line: string): void {
    if (ctx.truncated) return;
    const s = "  ".repeat(Math.min(depth, 12)) + line;
    if (ctx.used + s.length + 1 > ctx.max) {
      ctx.truncated = true;
      return;
    }
    ctx.lines.push(s);
    ctx.used += s.length + 1;
  }

  private emitText(ctx: Ctx, depth: number, t: string, owner: Element): void {
    if (!t) return;
    if (t.length > MAX_TEXT_LINE)
      this.emit(ctx, depth, `[${this.refFor(owner, ctx)}] text ${quote(t.slice(0, MAX_TEXT_LINE) + "…")} (truncated)`);
    else this.emit(ctx, depth, `text ${quote(t)}`);
  }

  private href(a: Element): string {
    const raw = (a as HTMLAnchorElement).href || a.getAttribute("href") || "";
    try {
      const u = new URL(raw);
      const shown = u.origin === this.doc.location.origin ? u.pathname + u.search + u.hash : u.href;
      return neutralise(trunc(shown, 200));
    } catch {
      return neutralise(trunc(raw, 200));
    }
  }

  private submitsForm(el: Element): boolean {
    const isSubmitter =
      (el.localName === "button" && !["button", "reset"].includes((el as HTMLButtonElement).type)) ||
      (el.localName === "input" && ["submit", "image"].includes((el as HTMLInputElement).type));
    return isSubmitter && !!(el as HTMLButtonElement).form;
  }

  private inputLine(el: HTMLInputElement, ref: string): string {
    const type = el.type || "text";
    const name = quote(this.name(el));
    const dis = el.disabled ? " (disabled)" : "";
    if (BUTTON_INPUTS.has(type)) return `[${ref}] button ${name}${this.submitsForm(el) ? " (submits form)" : ""}${dis}`;
    if (type === "checkbox" || type === "radio") return `[${ref}] ${type} ${name}${el.checked ? " (checked)" : ""}${dis}`;
    const value = el.value ? ` value=${quote(trunc(clean(el.value), 100))}` : "";
    return `[${ref}] textbox ${name}${value}${dis}`;
  }

  private walk(el: Element, depth: number, ctx: Ctx, marked: Set<Element>): void {
    if (ctx.truncated || this.skipped(el)) return;
    if (this.redundantLabel(el)) return;
    const tag = el.localName;
    const isControl = tag === "input" || tag === "textarea" || tag === "select";
    if (this.matchesBlocked(el, false)) {
      this.emit(ctx, depth, isControl ? "[redacted input]" : "[redacted element]");
      return;
    }
    const role = el.getAttribute("role")?.toLowerCase();
    const landmark = (role && LANDMARK_ROLES[role]) || LANDMARK_TAGS[tag];
    if (landmark) {
      const at = ctx.lines.length;
      this.emit(ctx, depth, `[${landmark} ${this.refFor(el, ctx)}]`);
      this.children(el, depth + 1, ctx, marked);
      // Drop landmarks with nothing visible inside; they only cost tokens.
      if (!ctx.truncated && ctx.lines.length === at + 1) {
        ctx.used -= ctx.lines[at]!.length + 1;
        ctx.lines.splice(at, 1);
      }
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      const t = trunc(clean(this.text(el)), 200);
      if (t) this.emit(ctx, depth, `[${this.refFor(el, ctx)}] heading ${quote(t)} (${tag})`);
      return;
    }
    if ((tag === "a" && el.hasAttribute("href")) || role === "link") {
      const href = tag === "a" ? this.href(el) : "";
      this.emit(ctx, depth, `[${this.refFor(el, ctx)}] link ${quote(this.name(el) || "(unnamed)")}${href ? ` -> ${href}` : ""}`);
      return;
    }
    if (tag === "button" || role === "button") {
      const dis = (el as HTMLButtonElement).disabled ? " (disabled)" : "";
      this.emit(ctx, depth, `[${this.refFor(el, ctx)}] button ${quote(this.name(el) || "(unnamed)")}${this.submitsForm(el) ? " (submits form)" : ""}${dis}`);
      return;
    }
    if (tag === "input") {
      this.emit(ctx, depth, this.inputLine(el as HTMLInputElement, this.refFor(el, ctx)));
      return;
    }
    if (tag === "textarea") {
      const v = (el as HTMLTextAreaElement).value;
      this.emit(ctx, depth, `[${this.refFor(el, ctx)}] textbox ${quote(this.name(el))}${v ? ` value=${quote(trunc(clean(v), 100))}` : ""}`);
      return;
    }
    if (tag === "select") {
      const s = el as HTMLSelectElement;
      const opts = Array.from(s.options).slice(0, 15).map((o) => clean(o.text)).join(" | ");
      const sel = s.selectedOptions[0] ? ` value=${quote(clean(s.selectedOptions[0].text))}` : "";
      this.emit(ctx, depth, `[${this.refFor(el, ctx)}] combobox ${quote(this.name(el))}${sel} options: ${quote(opts)}`);
      return;
    }
    if (tag === "tr" && !marked.has(el)) {
      const cells = Array.from(el.children).map((c) => clean(this.text(c))).filter(Boolean);
      if (cells.length) this.emit(ctx, depth, `row ${quote(cells.join(" | "))}`);
      return;
    }
    if (!marked.has(el)) {
      this.emitText(ctx, depth, clean(this.text(el)), el);
      return;
    }
    this.children(el, depth, ctx, marked);
  }

  private children(el: Element, depth: number, ctx: Ctx, marked: Set<Element>): void {
    let buf = "";
    const flush = () => {
      this.emitText(ctx, depth, clean(buf), el);
      buf = "";
    };
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) {
        buf += n.nodeValue ?? "";
        continue;
      }
      if (n.nodeType !== 1) continue;
      const c = n as Element;
      if (this.redundantLabel(c)) continue;
      if (!marked.has(c) && !c.matches(SPECIAL) && this.isInline(c)) {
        buf += ` ${this.text(c)} `;
        continue;
      }
      flush();
      this.walk(c, depth, ctx, marked);
    }
    flush();
  }

  snapshot(o: SnapshotOptions): SnapshotResult {
    this.sel = o.blockedSelectors;
    let root: Element | undefined = this.doc.body ?? this.doc.documentElement;
    if (o.scope) {
      root = this.resolve(o.scope);
      if (!root) return { status: "stale" };
      if (this.matchesBlocked(root, true)) return { status: "blocked" };
    }
    const header = `<untrusted_page_content url="${attrSafe(this.doc.location.href)}" snapshot="${o.snapshotId}">`;
    const footer = "</untrusted_page_content>";
    const ctx: Ctx = { counter: Math.max(o.nextRef, this.maxRef + 1), // never reissue a ref this document already handed out
       lines: [], used: header.length + footer.length + 120, max: o.maxChars, truncated: false };

    const marked = new Set<Element>();
    // Blocked elements count as special so their ancestors recurse and emit the redaction marker.
    for (const selector of [SPECIAL, ...o.blockedSelectors]) {
      let found: Element[];
      try {
        found = Array.from(root.querySelectorAll(selector));
      } catch {
        continue; // invalid selector in policy
      }
      for (const s of found) for (let p = s.parentElement; p && !marked.has(p); p = p.parentElement) marked.add(p);
    }
    if (root.matches(SPECIAL)) marked.add(root); // scoped to a special element: still walk its own line

    if (!o.scope) this.emit(ctx, 0, `title ${quote(trunc(clean(this.doc.title), 200))}`);
    this.walk(root, 0, ctx, marked);
    const lines = dropRedundantUnnamed(ctx.lines);
    if (ctx.truncated) lines.push("… truncated: pass scope=<ref> to read part of the page, or scroll");
    return { status: "ok", snapshot: [header, ...lines, footer].join("\n"), truncated: ctx.truncated, nextRef: ctx.counter };
  }

  // ---- element operations -------------------------------------------------------------------

  facts(ref: string, blockedSelectors: string[]): Facts {
    this.sel = blockedSelectors;
    const el = this.resolve(ref);
    return el ? this.factsOf(el, undefined) : { status: "stale" };
  }

  /** Facts about the focused element, for key presses (which carry no ref). */
  activeFacts(key: string, blockedSelectors: string[]): Facts {
    this.sel = blockedSelectors;
    const el = this.doc.activeElement;
    if (!el || el === this.doc.body || el === this.doc.documentElement)
      return { status: "ok", blocked: false, submits: false, label: "page (no focused element)" };
    return this.factsOf(el, key);
  }

  private factsOf(el: Element, key: string | undefined): Facts {
    const inputType = (el as HTMLInputElement).type;
    // Enter in any typing field (password included) submits its form; classify conservatively.
    const textLike = el.localName === "input" && (inputType === "password" || !NON_TEXT_INPUTS.has(inputType)) && !!(el as HTMLInputElement).form;
    const submits =
      key === undefined
        ? this.submitsForm(el)
        : (key === "Enter" && (textLike || this.submitsForm(el))) || (key === " " && this.submitsForm(el));
    const isLink = el.localName === "a" && el.hasAttribute("href");
    return {
      status: "ok",
      blocked: this.matchesBlocked(el, true),
      submits,
      href: isLink && (key === undefined || key === "Enter") ? (el as HTMLAnchorElement).href : undefined,
      label: this.label(el),
      form: this.formInfo(el),
    };
  }

  /** Short human description, shown to you when approving an action. */
  private label(el: Element): string {
    const tag = el.localName;
    const name = quote(this.name(el));
    if (tag === "a") return `link ${name} -> ${this.href(el)}`;
    if (tag === "button" || (tag === "input" && BUTTON_INPUTS.has((el as HTMLInputElement).type))) return `button ${name}`;
    if (tag === "input") return `${(el as HTMLInputElement).type || "text"} input ${name}`;
    if (tag === "select") return `combobox ${name}`;
    if (tag === "textarea") return `textbox ${name}`;
    return `${tag} ${name}`;
  }

  private formInfo(el: Element): FormInfo | undefined {
    const form = (el as HTMLInputElement).form ?? el.closest("form");
    if (!form) return undefined;
    const fields: FormInfo["fields"] = [];
    for (const f of Array.from(form.elements).slice(0, 60)) {
      const type = (f as HTMLInputElement).type;
      if (["button", "submit", "reset", "image", "hidden"].includes(type)) continue;
      const name = (f as HTMLInputElement).name || f.id || f.localName;
      if (type === "file" || type === "password" || this.matchesBlocked(f, true)) {
        fields.push({ name, value: "[redacted]" });
      } else if ((type === "checkbox" || type === "radio") && !(f as HTMLInputElement).checked) {
        continue;
      } else {
        fields.push({ name, value: trunc(clean((f as HTMLInputElement).value ?? ""), 100) });
      }
      if (fields.length >= 30) break;
    }
    return { action: form.action, method: (form.method || "get").toLowerCase(), fields };
  }

  // ---- actions --------------------------------------------------------------------------
  // Each re-checks blocked selectors itself: a second layer behind the policy.

  private actionTarget(ref: string, sel: string[]): Element | ActionResult {
    this.sel = sel;
    const el = this.resolve(ref);
    if (!el) return { status: "stale" };
    if (this.matchesBlocked(el, true)) return { status: "blocked" };
    return el;
  }

  click(ref: string, sel: string[]): ActionResult {
    const t = this.actionTarget(ref, sel);
    if ("status" in t) return t;
    if ((t as HTMLButtonElement).disabled) return { status: "error", message: "element is disabled" };
    if (this.hidden(t)) return { status: "error", message: "element is not visible" };
    (t as HTMLElement).scrollIntoView?.({ block: "center" });
    (t as HTMLElement).click();
    return { status: "ok" };
  }

  type(ref: string, text: string, clear: boolean, sel: string[]): ActionResult {
    const t = this.actionTarget(ref, sel);
    if ("status" in t) return t;
    const w = this.win;
    const isArea = t instanceof w.HTMLTextAreaElement;
    const isText = t instanceof w.HTMLInputElement && !NON_TEXT_INPUTS.has(t.type);
    if (!isArea && !isText) return { status: "error", message: "not a text field" };
    const field = t as HTMLInputElement | HTMLTextAreaElement;
    if (field.disabled || field.readOnly) return { status: "error", message: "field is disabled or read-only" };
    field.focus();
    // React-style apps track the value via the prototype setter, so assign through it, then fire events.
    const setter = Object.getOwnPropertyDescriptor(isArea ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, (clear ? "" : field.value) + text);
    field.dispatchEvent(new w.InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    field.dispatchEvent(new w.Event("change", { bubbles: true }));
    return { status: "ok" };
  }

  select(ref: string, value: string, sel: string[]): ActionResult {
    const t = this.actionTarget(ref, sel);
    if ("status" in t) return t;
    if (!(t instanceof this.win.HTMLSelectElement)) return { status: "error", message: "not a <select>" };
    const opt =
      Array.from(t.options).find((o) => o.value === value) ?? Array.from(t.options).find((o) => clean(o.text) === clean(value));
    if (!opt) return { status: "error", message: `no option matching ${JSON.stringify(trunc(value, 60))}` };
    if (t.disabled || opt.disabled) return { status: "error", message: "option or select is disabled" };
    t.value = opt.value;
    t.dispatchEvent(new this.win.Event("input", { bubbles: true }));
    t.dispatchEvent(new this.win.Event("change", { bubbles: true }));
    return { status: "ok" };
  }

  pressKey(key: string, sel: string[]): ActionResult {
    this.sel = sel;
    const w = this.win;
    const el = this.doc.activeElement ?? this.doc.body;
    const onPage = el !== this.doc.body && el !== this.doc.documentElement;
    if (onPage && this.matchesBlocked(el, true)) return { status: "blocked" };
    const init = { key, bubbles: true, cancelable: true };
    const proceed = el.dispatchEvent(new w.KeyboardEvent("keydown", init));
    if (proceed && onPage) {
      // Synthetic key events have no default actions, so reproduce the important ones.
      const isButtonLike = el.localName === "button" || (el.localName === "input" && BUTTON_INPUTS.has((el as HTMLInputElement).type));
      if (key === "Enter") {
        const form = (el as HTMLInputElement).form;
        if (el.localName === "input" && !isButtonLike && form) form.requestSubmit();
        else if (isButtonLike || el.localName === "a") (el as HTMLElement).click();
      } else if (key === " " && isButtonLike) {
        (el as HTMLElement).click();
      } else if (key === "Tab") {
        const all = Array.from(this.doc.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => !(e as HTMLButtonElement).disabled && !this.hidden(e) && e.tabIndex >= 0);
        const i = all.indexOf(el as HTMLElement);
        all[(i + 1) % all.length]?.focus();
      }
    }
    el.dispatchEvent(new w.KeyboardEvent("keyup", init));
    return { status: "ok" };
  }

  getText(ref: string, blockedSelectors: string[]): { status: "ok"; text: string } | { status: "stale" | "blocked" } {
    this.sel = blockedSelectors;
    const el = this.resolve(ref);
    if (!el) return { status: "stale" };
    if (this.matchesBlocked(el, true)) return { status: "blocked" };
    let body: string;
    if (el instanceof this.win.HTMLInputElement || el instanceof this.win.HTMLTextAreaElement) body = el.value;
    else if (el instanceof this.win.HTMLSelectElement) body = el.selectedOptions[0]?.text ?? "";
    else body = this.text(el);
    const text = trunc(clean(body), 100_000);
    return {
      status: "ok",
      text: `<untrusted_page_content url="${attrSafe(this.doc.location.href)}" element="${ref}">\n${neutralise(text)}\n</untrusted_page_content>`,
    };
  }

  scroll(direction: "up" | "down", ref?: string): { status: "ok" | "stale" } {
    const target = ref ? this.resolve(ref) : undefined;
    if (ref && !target) return { status: "stale" };
    const dy = (direction === "down" ? 1 : -1) * 0.8 * (target ? target.clientHeight || 600 : this.win.innerHeight);
    if (target) target.scrollBy(0, dy);
    else this.win.scrollBy(0, dy);
    return { status: "ok" };
  }

  async waitFor(o: { text?: string; ref?: string; timeoutMs: number; blockedSelectors: string[] }): Promise<{ found: boolean }> {
    this.sel = o.blockedSelectors;
    const needle = o.text?.toLowerCase();
    const check = () => {
      if (o.ref) {
        const el = this.resolve(o.ref);
        return !!el && !this.hidden(el);
      }
      return needle !== undefined && this.text(this.doc.body).toLowerCase().includes(needle);
    };
    const deadline = Date.now() + o.timeoutMs;
    while (!check()) {
      if (Date.now() >= deadline) return { found: false };
      await new Promise((r) => setTimeout(r, 150));
    }
    return { found: true };
  }

  /** Screenshots cannot be redacted after the fact, so blocked elements are hidden while capturing. */
  hideBlocked(blockedSelectors: string[]): { hidden: number } {
    this.sel = blockedSelectors;
    this.restoreBlocked();
    const targets = new Set<HTMLElement>();
    for (const s of [...blockedSelectors, "input[type=password]"]) {
      try {
        this.doc.querySelectorAll<HTMLElement>(s).forEach((e) => targets.add(e));
      } catch {}
    }
    for (const el of targets) {
      const prev = el.style.getPropertyValue("visibility");
      const prio = el.style.getPropertyPriority("visibility");
      el.style.setProperty("visibility", "hidden", "important");
      this.restoreFns.push(() => (prev ? el.style.setProperty("visibility", prev, prio) : el.style.removeProperty("visibility")));
    }
    return { hidden: targets.size };
  }

  restoreBlocked(): { ok: true } {
    for (const fn of this.restoreFns.splice(0)) fn();
    return { ok: true };
  }
}
