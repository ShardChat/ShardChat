// SHARD — tiny shared helpers. No dependencies on purpose.

export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/[/+]/g, "_").replace(/=+$/, "");
}

/** Wire ids must be short base64url tokens: randomId() emits 12 chars.
 *  Peer-supplied ids are validated against this before touching the UI. */
const WIRE_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;

export function isValidId(id: unknown): id is string {
  return typeof id === "string" && WIRE_ID_RE.test(id);
}

export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Elapsed call clock (mm:ss or h:mm:ss). */
export function formatElapsed(ms: number): string {
  return formatCountdown(ms);
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
