// SHARD — useSessionHub: the multi-session registry. Pure React state, no
// persistence anywhere (the spec's "in RAM only" requirement) — a refresh
// wipes every parallel session at once, which is also what the beforeunload
// guard already warns about.
//
// Each entry owns its own WebSocket (mounted <Room> → useChatSession →
// useWebSocket), its own E2EE keys and its own message history, so a
// background session keeps decrypting and collecting unread messages while
// its chat stays off-screen. Only the active session is visible; the rest
// render in hidden layers (display:none), which keeps React state — and the
// sockets behind it — alive.
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_SESSIONS } from "../lib/sessionHub";

export interface HubSession {
  /** Stable per-tab key (also the layer key in the DOM). */
  key: string;
  roomId: string;
  /** Server expiry in epoch ms, latched from the create response. */
  expiresAt: number;
  /** Live phase mirrored up by the session's own <Room> instance. */
  phase: "connecting" | "waiting" | "exchanging" | "secure" | "peer_away" | "burned" | "gone" | "room_full";
  /** Unread peer messages while this session is in the background. */
  unread: number;
}

export type SidebarOpen = "open" | "collapsed";

interface NewSessionInput {
  roomId: string;
  expiresAt: number;
}

let seq = 0;
const nextKey = () => `s${++seq}-${Date.now().toString(36)}`;

export function useSessionHub() {
  const [sessions, setSessions] = useState<HubSession[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** Tracks which session the browser URL points at, so replaceState fires
   *  only on real switches. */
  const urlKeyRef = useRef<string | null>(null);
  /** Mirror for read-inside-updater code (unread accounting). */
  const activeKeyRef = useRef<string | null>(null);
  activeKeyRef.current = activeKey;
  const sessionsRef = useRef<HubSession[]>([]);
  sessionsRef.current = sessions;
  const [sidebar, setSidebar] = useState<SidebarOpen>(() =>
    window.matchMedia("(min-width: 768px)").matches ? "open" : "collapsed",
  );

  /** Adds a session and makes it active. The MAX_SESSIONS cap is enforced
   *  inside the updater so racing clicks in one tick cannot overshoot it;
   *  if the cap rejects the room, the reconcile effect below points
   *  activeKey back at a session that actually exists. */
  const addSession = useCallback((input: NewSessionInput) => {
    const key = nextKey();
    setSessions((prev) => {
      if (prev.length >= MAX_SESSIONS) return prev;
      return [...prev, { key, roomId: input.roomId, expiresAt: input.expiresAt, phase: "connecting", unread: 0 }];
    });
    setActiveKey(key);
    return key;
  }, []);

  const removeSession = useCallback((key: string) => {
    setSessions((prev) => prev.filter((s) => s.key !== key));
  }, []);

  const burnAll = useCallback(() => {
    // <Room> unmounts → its cleanup runs → useChatSession's teardown closes
    // every socket. The host navigates home once the list is empty.
    setSessions([]);
    setActiveKey(null);
  }, []);

  // Reconcile: activeKey must always point at a real session (never a
  // capped-out add, never a just-burned one). Newest survivor wins.
  useEffect(() => {
    if (activeKey && sessions.some((s) => s.key === activeKey)) return;
    setActiveKey(sessions.length ? sessions[sessions.length - 1]!.key : null);
  }, [sessions, activeKey]);

  /** Report from a mounted <Room>: phase mirror + unread accounting. */
  const report = useCallback((key: string, patch: { phase?: HubSession["phase"]; peerMessage?: boolean }) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.key !== key) return s;
        const unread =
          patch.peerMessage && activeKeyRef.current !== key && s.phase === "secure" ? s.unread + 1 : s.unread;
        return { ...s, phase: patch.phase ?? s.phase, unread };
      }),
    );
  }, []);

  const activate = useCallback((key: string) => {
    setActiveKey(key);
    setSessions((prev) => prev.map((s) => (s.key === key ? { ...s, unread: 0 } : s)));
  }, []);

  // URL stays in lockstep with the visible session — no history spam: each
  // switch replaces the entry instead of pushing one.
  useEffect(() => {
    if (urlKeyRef.current === activeKey) return;
    urlKeyRef.current = activeKey;
    if (!activeKey) return;
    const current = sessionsRef.current.find((s) => s.key === activeKey);
    if (current) window.history.replaceState(null, "", `/room/${current.roomId}`);
  }, [activeKey]);

  // Reset the sticky ref when the hub empties so a later re-entry re-syncs.
  useEffect(() => {
    if (sessions.length === 0) urlKeyRef.current = null;
  }, [sessions.length]);

  return {
    sessions,
    activeKey,
    activeSession: sessions.find((s) => s.key === activeKey) ?? null,
    sidebar,
    setSidebar,
    toggleSidebar: useCallback(() => setSidebar((v) => (v === "open" ? "collapsed" : "open")), []),
    addSession,
    removeSession,
    burnAll,
    activate,
    report,
  };
}

export type SessionHub = ReturnType<typeof useSessionHub>;
