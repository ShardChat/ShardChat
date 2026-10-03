// SHARD — endpoint resolution for split deployments.
//
// By default the client is same-origin: the SPA, /api and /ws are served by
// one process, so nothing is configured and the browser's own origin is used.
// When the static bundle (Vercel) and the Go relay (Render) live on different
// hosts, VITE_API_BASE / VITE_WS_URL point at the relay and every REST call
// and the socket upgrade become cross-origin — which the relay allows through
// its CORS middleware and its ALLOWED_ORIGINS allow-list.
//
// Both variables are baked in at BUILD time, so a page visitor can never
// influence them; the scheme checks below are a build guard rather than an
// attack surface. They throw while this module is evaluated — before React
// mounts — so a typo or a stray value reports the exact variable and scheme
// in the console instead of shipping a bundle whose sockets silently never
// open.

const WS_SCHEMES = new Set(["ws:", "wss:"]);
const HTTP_SCHEMES = new Set(["http:", "https:"]);

/** Strips trailing slashes so `${base}/api/...` never doubles up. */
function normalizeBase(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/**
 * Parses a configured base and rejects anything that is not an allowed
 * scheme. `javascript:` and `data:` can never reach a WebSocket or fetch, but
 * an explicit allow-list keeps a misconfiguration from degrading into a dead
 * socket or a request to an unexpected host.
 */
function requireScheme(value: string, allowed: Set<string>, variable: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} is not an absolute URL: ${JSON.stringify(value)}`);
  }
  if (!allowed.has(url.protocol)) {
    throw new Error(`${variable} must use one of ${[...allowed].join(", ")} — got ${url.protocol}`);
  }
  return value;
}

function resolveApiBase(): string {
  const configured = normalizeBase(import.meta.env.VITE_API_BASE);
  if (!configured) return ""; // same-origin, the single-container default
  return requireScheme(configured, HTTP_SCHEMES, "VITE_API_BASE");
}

function resolveWsBase(): string {
  const configured = normalizeBase(import.meta.env.VITE_WS_URL);
  if (configured) {
    const checked = requireScheme(configured, WS_SCHEMES, "VITE_WS_URL");
    // An https page may not open an insecure socket: mixed content would be
    // blocked by the browser with no useful diagnostic.
    if (location.protocol === "https:" && new URL(checked).protocol !== "wss:") {
      throw new Error("VITE_WS_URL must use wss: on an https page");
    }
    return checked;
  }
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}`;
}

const API_BASE = resolveApiBase();
const WS_BASE = resolveWsBase();

/** REST base URL; empty string keeps requests same-origin and relative. */
export function apiBase(): string {
  return API_BASE;
}

/** REST endpoint, e.g. api("/api/rooms"). */
export function api(path: string): string {
  return `${API_BASE}${path}`;
}

/**
 * WebSocket base URL. Falls back to the page's own origin, deriving the
 * scheme from the current protocol so an https page never opens an insecure
 * ws:// socket.
 */
export function wsBase(): string {
  return WS_BASE;
}

/** Socket endpoint for a session. The id is percent-encoded so a crafted
 *  path segment can never escape into the query or another route. */
export function wsEndpoint(roomId: string): string {
  return `${WS_BASE}/ws/${encodeURIComponent(roomId)}`;
}
