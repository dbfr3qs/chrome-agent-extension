# Browser Bridge

A local-only Chrome extension plus a small native host that lets coding agents (Claude Code, a custom harness, any shell-capable agent) read and act in your real Chrome — with every action checked against a **deny-by-default policy that lives inside the extension**, where the agent cannot edit it.

Loaded unpacked, one person, one machine. Not for the Chrome Web Store. Nothing listens on a network port.

```
agent ── MCP (stdio) / bb CLI / @bb/client ──▶ unix socket ──▶ native host ──▶ extension (service worker)
                                                0600                          policy + audit + confirmations
                                                                              └─▶ content script in Agent-group tabs
```

Everything left of the extension carries no authority: it only translates calls.

## Install

Needs Chrome, Node 22 (`nvm use 22`; see `.nvmrc`) and pnpm 9 (`npx pnpm@9 …` works if you have no pnpm).

```sh
pnpm install
pnpm build                    # builds every package; extension lands in packages/extension/dist
pnpm host:install             # registers the native host, restricted to this extension's ID
ln -s "$PWD/packages/cli/dist/bb.js" ~/.local/bin/bb    # optional: `bb` on your PATH
```

1. `chrome://extensions` → Developer mode → **Load unpacked** → `packages/extension/dist`. Do this in a dedicated profile if you can — see [Run it in a dedicated Chrome profile](#run-it-in-a-dedicated-chrome-profile-recommended).
2. The ID must be `hlmckamnikhalaijbocbikfadoogehak` (pinned by the key in `packages/extension/keys/`). The badge shows **PAUSED**; click the toolbar icon to switch to **ON**.
3. Open the extension's options page and add sites (below). With no sites, everything is denied.
4. After rebuilding, **reload the extension** at `chrome://extensions`. Rerun `pnpm host:install` if you change Node versions (the launcher pins an absolute `node`).

Claude Code (MCP):

```sh
claude mcp add --scope user browser -- node "$PWD/packages/mcp-server/dist/index.js"
```

Optional convenience gate in `~/.claude/settings.json` (the extension's policy is what actually holds):

```json
{ "permissions": {
    "allow": ["mcp__browser__tabs_list", "mcp__browser__snapshot", "mcp__browser__get_text",
              "mcp__browser__scroll", "mcp__browser__wait_for", "mcp__browser__tab_close"],
    "ask":   ["mcp__browser__tab_open", "mcp__browser__follow_link", "mcp__browser__navigate",
              "mcp__browser__back", "mcp__browser__click", "mcp__browser__type",
              "mcp__browser__select", "mcp__browser__press_key", "mcp__browser__screenshot"] } }
```

## Run it in a dedicated Chrome profile (recommended)

Chrome profiles keep extensions, cookies, logins and extension storage (including this policy) separate. Run Browser Bridge in its own profile so the agent never shares a session with your daily browsing. No code changes are needed.

1. **Create the profile.** Chrome avatar (top right) → *Add profile* → *Continue without an account*. Don't sign into Chrome there: sync would pull in your passwords and autofill, which is what you're isolating from. Name it "Agent" and give it a distinct colour or theme.
2. **Turn off the password manager and autofill** in that profile (Settings → Autofill and passwords).
3. **Note its folder name.** In that profile open `chrome://version` and read the last part of *Profile Path* (e.g. `Profile 2`).
4. **Load the extension in that profile only:** `chrome://extensions` → Developer mode → *Load unpacked* → `packages/extension/dist`. The ID is unchanged, and the native host registration is per Chrome install, so `pnpm host:install` needn't be rerun.
5. **Recreate the policy there.** Extension storage is per profile, so the new profile starts deny-all. Add your sites on the options page, then click the toolbar icon so the badge reads **ON**.
6. **Sign in only to the sites the agent needs**, ideally with accounts that have no more access than the task requires.
7. **Remove the extension from your daily profile.** If it is loaded in two open profiles, each runs its own native host and the second silently replaces the first one's socket, so `bb` would talk to whichever profile started last.

Day to day:

- The agent profile's window must be open: the extension's service worker and the host only run while it is. If it isn't, `bb` returns `HOST_UNAVAILABLE`.
- Launch it from a terminal with `open -na "Google Chrome" --args --profile-directory="Profile 2"` (use your folder name). Both profiles run side by side in the same Chrome.
- Agent tabs appear in the purple "Agent" group in that profile's window. Tabs in your daily profile are out of reach twice over: a different profile, and outside the group.

This isolates logins and browser state; it is not a sandbox against a shell-capable agent. The agent runs as you and could read the profile folder on disk (cookies included), so only put logins in this profile that you are prepared to expose that way. See the threat model below.

## Policy

Edited only on the extension's options page and stored in `chrome.storage.local`. A missing or invalid policy is deny-all.

```json
{
  "version": 1,
  "default": "off",
  "sites": [
    { "match": "https://docs.example.com/*", "mode": "read", "navigation": "links-only" },
    { "match": "http://localhost:5173/*", "mode": "write", "navigation": "patterns",
      "patterns": ["http://localhost:5173/*"], "allowQuery": ["page", "q"] }
  ],
  "blockedSelectors": ["input[type=password]", "[autocomplete^=cc-]", "input[type=file]"],
  "limits": { "actionsPerSession": 200, "actionsPerMinute": 30 },
  "confirm": { "timeoutSeconds": 60 }
}
```

| Mode | Allows |
|---|---|
| `off` | nothing (everything unlisted) |
| `read` | snapshot, get_text, scroll, wait_for, screenshot, follow_link to allowlisted pages |
| `interact` | read + click, type, select, press_key — **but not anything that submits a form** |
| `write` | interact + submits; **each submit asks you first** |

- **First matching site rule wins.** Put narrow rules before broad ones.
- `match` is `scheme://host[:port]/path-glob`. The only host wildcard is a leading `*.`. Matching is done on the *parsed* URL, so `docs.example.com@evil.test` and `docs.example.com.evil.test` do not match.
- `navigation: "links-only"`: the agent can only follow links present on the page (`follow_link`, or clicking one); it cannot construct URLs. `"patterns"` also lets it call `navigate(url)` for URLs matching `patterns`, with query parameters stripped unless listed in `allowQuery`.
- Clicking a link (or Enter on one) is held to the same allowlist as `follow_link`.
- Exceeding either limit **pauses the session**; resume with the toolbar icon (which also resets the budget).

## Using it

```sh
bb tab-open https://docs.example.com/        # opens in the purple "Agent" tab group
bb tabs
bb snapshot --tab 123                        # text tree with refs like [e5]
bb click --tab 123 e5      bb type --tab 123 e4 "query" --clear      bb key --tab 123 Enter
bb follow --tab 123 e3     bb back --tab 123     bb text --tab 123 e7     bb screenshot --tab 123 -o x.png
```

Refs go stale on navigation (`STALE_REF`): take a new snapshot. Errors are typed: `POLICY_DENIED`, `USER_DENIED`, `CONFIRM_TIMEOUT`, `STALE_REF`, `NOT_FOUND`, `TAB_NOT_IN_GROUP`, `RATE_LIMITED`, `PAUSED`, `HOST_UNAVAILABLE`.

**Confirmations** open in the Browser Bridge panel (a small popup window if the side panel isn't open; Chrome only opens the panel from a click). It shows the page, the element, the form's destination and its field values (secrets redacted). Unanswered after 60 s is a denial, and if the caller disconnects the request is cancelled. After you approve, the extension re-reads the page and refuses if it changed.

**Audit:** every request, decision, approver and result summary goes to `~/.browser-bridge/audit.jsonl` (0600) and the last 500 entries show in the panel.

## Threat model

**Untrusted:** the LLM, every agent-side process, and all page content. **Trusted:** the extension's service worker, options page and panel, and Chrome. The agent cannot target `chrome://` or `chrome-extension://` pages, so it cannot open the options page or press its own Approve button; only the panel page can answer a confirmation (checked by sender URL).

What the design stops:

| Attack | Control |
|---|---|
| Page text says "go to attacker.test?d=…" | no site rule → `POLICY_DENIED`; links-only forbids constructing URLs; query params stripped |
| Hidden instructions (`display:none`, opacity 0, zero-width chars) | not included in snapshots |
| Page fakes the `</untrusted_page_content>` wrapper | wrapper tags in page text are neutralised |
| Redirect to an unlisted host | landing page re-checked; tab closed and logged (also for failed loads) |
| Reading passwords / card numbers | blocked selectors (and `type=password` always) are redacted in snapshots and hidden in screenshots, and cannot be typed into or clicked |
| Agent submits a form on a trusted site | needs `write` mode **and** your approval of exactly what's shown |
| Runaway agent | action budget, per-minute rate limit, kill switch |
| Agent edits its own policy | policy lives in extension storage, editable only via the options page |

What it does **not** stop:

- **Prompt injection inside an allowlisted site.** Visible malicious text still reaches the model. The design limits blast radius (modes, links-only, confirmations); it does not make content trustworthy. Keep `write` sites few.
- **A shell-capable agent attacking Chrome itself.** The agent runs as you. It could read or alter your Chrome profile on disk, launch its own browser, or edit native-messaging manifests. This is a policy gate for the *browser tools*, not a sandbox. Pair it with your agent's own sandboxing and consider a dedicated Chrome profile that has only the logins you choose.
- **JavaScript-driven state changes.** A `type=button` that submits via `fetch` can't be recognised as a submit, so `interact` mode doesn't prevent it. Don't give `interact` to sites where a stray click is costly.
- **Logged-in sessions.** The agent uses your session on allowlisted sites. Never allowlist email, banking or admin consoles.
- **Screenshots** are viewport PNGs: blocked elements are hidden, but other sensitive content on screen is not. They briefly switch to the agent tab.
- Snapshots don't see inside iframes or shadow DOM.

## Development

```sh
pnpm test                 # unit tests: policy matrix, framing, bridge, walker (jsdom), confirm queue, MCP server
pnpm fixtures             # local test site on http://localhost:5173
pnpm test:injection       # live prompt-injection suite (see below)
```

`pnpm test:injection` drives the real extension through the fixture site: hidden text, spoofed wrappers, attacker/`chrome-extension://`/`javascript:` links and `tab_open` URLs, credential and suffix tricks, form submits, redacted secrets, and a redirect out of the allowlist. Pass means every attempt was denied or needs you, none succeeded silently, and each is in the audit log. It needs a rule for `http://localhost:5173/*` in `interact` mode (in `write` mode the submit checks wait for you and report a warning), and it paces itself under the rate limit.

Layout: `packages/protocol` (zod schemas, errors, JSON-RPC) · `extension` (MV3: policy, content script, panel, options) · `host` (native messaging + socket + audit file) · `client` (`@bb/client`) · `cli` (`bb`, injection suite) · `mcp-server` · `pi` (not built) · `fixtures/`.
