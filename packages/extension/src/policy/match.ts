import type { Policy, Site } from "./schema.js";

/** scheme://[*.]host[:port]/path-glob — the host never contains a wildcard except a leading "*." */
export const PATTERN_RE = /^(https?):\/\/(\*\.)?([A-Za-z0-9.-]+)(?::(\d+))?(\/.*)$/;

/** Only plain http(s) URLs without embedded credentials are ever considered. */
export function parseHttpUrl(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (u.username || u.password) return undefined;
  return u;
}

const globToRegExp = (glob: string) =>
  new RegExp("^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

/** Matches scheme, host, port and pathname of the *parsed* URL; the query string is ignored. */
export function matchUrl(pattern: string, u: URL): boolean {
  const m = PATTERN_RE.exec(pattern);
  if (!m) return false;
  const [, scheme, wild, host, port, path] = m;
  if (u.protocol !== `${scheme}:`) return false;
  const h = host!.toLowerCase();
  if (wild ? !u.hostname.endsWith(`.${h}`) : u.hostname !== h) return false;
  const defaultPort = scheme === "https" ? "443" : "80";
  if ((u.port || defaultPort) !== (port ?? defaultPort)) return false;
  return globToRegExp(path!).test(u.pathname);
}

/** First matching site rule wins. */
export function findSite(policy: Policy, u: URL): Site | undefined {
  return policy.sites.find((s) => matchUrl(s.match, u));
}
