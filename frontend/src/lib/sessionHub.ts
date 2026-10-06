// SHARD — multi-session hub helpers. The session registry itself lives in
// React state (hooks/useSessionHub) — volatile memory only, matching the
// zero-persistence guarantee: a refresh destroys every session at once.
// This module holds just the pure pieces: the REST room creation call and
// display helpers shared by the sidebar and the host.
import { api } from "./endpoints";
import type { CreateRoomResponse } from "../types/protocol";

/** Hard cap on parallel sessions in one tab: each session holds a WebSocket,
 *  a WebRTC peer connection pool and its whole message history in memory. */
export const MAX_SESSIONS = 6;

/** POST /api/rooms — asks the relay for a fresh one-time room. Mirrors the
 *  SessionSetup page's call so the sidebar's "+ New Session" behaves exactly
 *  like the full setup flow (same error surface, same TTL whitelist). */
export async function createRoom(ttlMinutes: number): Promise<CreateRoomResponse> {
  const res = await fetch(api("/api/rooms"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ttlMinutes }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Server responded ${res.status}`);
  }
  return (await res.json()) as CreateRoomResponse;
}

/** Compact display id for the sidebar card: "#A7F3". Room ids are
 *  case-insensitive on the wire, so the label is uppercased for looks. */
export function shortRoomId(roomId: string): string {
  return roomId.slice(0, 4).toUpperCase();
}
