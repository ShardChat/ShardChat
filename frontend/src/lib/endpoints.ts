// SHARD — endpoint resolution for split deployments.
//
// By default the client is same-origin: the SPA, /api and /ws are served by
// one process, so nothing is configured and the browser's own origin is used.
// When the static bundle and the Go relay are served from different
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
  return `${WS_BASE}/ws/${encodeURIComponent(roomId)}?seat=${seatToken()}`;
}

/**
 * Media signaling socket on the standalone `shard-media` SFU node.
 * Unset VITE_MEDIA_URL falls back to the page's own origin with a scheme
 * derived from the current protocol, so an https page always opens wss:.
 */
export function mediaWsEndpoint(roomId: string): string {
  const base = import.meta.env.VITE_MEDIA_URL
    ? import.meta.env.VITE_MEDIA_URL.replace(/\/+$/, '')
    : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
  return `${base}/ws/${encodeURIComponent(roomId)}`;
}

/** ICE/TURN bootstrap for P2P calls, served by the Go relay so the browser
 *  bundle never hardcodes third-party credentials. */
export function webrtcConfigEndpoint(): string {
  return api('/api/webrtc-config');
}

const SEAT_KEY = "shard.seat";

/**
 * A random token identifying this browser TAB, not the person.
 *
 * The relay seats exactly two participants and cannot tell "the same phone
 * came back after the OS suspended its socket" from "a third peer joined the
 * link". Sending a stable token lets the server hand the seat back to whoever
 * already held it, instead of locking the returning participant out of its
 * own session.
 *
 * sessionStorage (not localStorage) is deliberate: it survives a reload in the
 * same tab — the case that matters — but not across tabs or browser restarts,
 * so a genuinely new visitor never inherits a seat.
 */
function seatToken(): string {
  try {
    const existing = sessionStorage.getItem(SEAT_KEY);
    if (existing) return existing;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let token = "";
    for (const b of bytes) token += b.toString(16).padStart(2, "0");
    sessionStorage.setItem(SEAT_KEY, token);
    return token;
  } catch {
    // Private mode / blocked storage: connect without a seat. The relay
    // treats a missing token as "claim no seat" and everything still works
    // except reclaiming a seat across a reconnect.
    return "";
  }
}
