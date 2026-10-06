// SHARD — RoomHost: desktop multi-session workspace. Renders the session
// sidebar plus one <Room> instance per session, stacked in layers. Hidden
// layers stay mounted (display:none), so every background session keeps its
// WebSocket, E2EE keys and message history alive in React memory — nothing
// ever touches localStorage. Switching a session is an instant layer flip.
import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { navigate } from "../../App";
import { createRoom } from "../../lib/sessionHub";
import { useSessionHub } from "../../hooks/useSessionHub";
import { Room, type RoomHandle } from "./Room";
import { SessionSidebar } from "./SessionSidebar";

export function RoomHost({ initialRoomId, onExit }: { initialRoomId: string; onExit: () => void }) {
  const hub = useSessionHub();
  const { sessions, activeKey, sidebar, setSidebar } = hub;
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** Registers each mounted Room's imperative handle by session key. */
  const handles = useRef(new Map<string, RoomHandle>());

  // Seed the hub with the room this tab navigated in on, before the first
  // paint: sessions.length===0 is also the "all gone, navigate home" signal,
  // so an empty first frame would bounce the user straight back to "/".
  // useReducer's dispatch runs the initializer synchronously during the
  // first render, so there is never an empty frame.
  const [seeded] = useState(() => {
    hub.addSession({ roomId: initialRoomId, expiresAt: Date.now() + 30 * 60_000 });
    return true;
  });
  void seeded;

  // Cmd/Ctrl + \ toggles the panel; Shift+\ (unmodified) stays free for "?".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "\\" && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        hub.toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hub]);

  // Memory-only guarantee: leaving the tab mid-session destroys everything.
  // Same message as the single-session Room guard.
  useEffect(() => {
    if (sessions.length === 0) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue =
        "Warning: closing the tab or refreshing the page destroys all sessions and messages forever. Are you sure?";
      return e.returnValue;
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [sessions.length]);

  const createSession = useCallback(
    async (ttlMinutes: number) => {
      setCreating(true);
      setCreateError(null);
      try {
        const room = await createRoom(ttlMinutes);
        hub.addSession({ roomId: room.roomId, expiresAt: Date.parse(room.expiresAt) || Date.now() + ttlMinutes * 60_000 });
      } catch (e) {
        setCreateError(e instanceof Error ? e.message : "Unknown error");
        throw e; // the picker stays open and shows this error
      } finally {
        setCreating(false);
      }
    },
    [hub],
  );

  const burnAll = useCallback(() => {
    handles.current.forEach((h) => h.burn());
    handles.current.clear();
    hub.burnAll();
    onExit();
  }, [hub, onExit]);

  const burnOne = useCallback(
    (key: string) => {
      handles.current.get(key)?.burn();
      handles.current.delete(key);
      hub.removeSession(key);
    },
    [hub],
  );

  // Every session gone (all burned / all expired): back to the landing page.
  // The seeded guard makes sure this never fires on the very first render,
  // where the hub legitimately starts empty for one frame.
  useEffect(() => {
    if (seeded && sessions.length === 0) onExit();
  }, [seeded, sessions.length, onExit]);

  const drawer = sidebar === "open" && window.innerWidth < 768;

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* ---------- SIDEBAR: desktop rail / mobile drawer ---------- */}
      {/* Desktop rail */}
      {sidebar === "open" && (
        <aside
          className="z-30 hidden h-full w-64 shrink-0 border-r border-zinc-200 bg-zinc-50/50 backdrop-blur-xl transition-all duration-200 md:flex md:flex-col dark:border-zinc-800 dark:bg-zinc-950/50"
          aria-label="Sessions"
        >
          <SessionSidebar
            sessions={sessions}
            activeKey={activeKey}
            onCreate={createSession}
            creating={creating}
            createError={createError}
            onClearCreateError={() => setCreateError(null)}
            onActivate={hub.activate}
            onBurnOne={burnOne}
            onBurnAll={burnAll}
            onNavigate={() => {}}
            onClose={() => setSidebar("collapsed")}
          />
        </aside>
      )}

      {/* Mobile drawer */}
      <div
        className={`fixed inset-0 z-40 md:hidden ${drawer ? "" : "pointer-events-none"}`}
        aria-hidden={!drawer}
      >
        <div
          onClick={() => setSidebar("collapsed")}
          className={`absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-200 ${
            drawer ? "opacity-100" : "opacity-0"
          }`}
        />
        <aside
          className={`absolute inset-y-0 left-0 w-72 border-r border-zinc-200 bg-zinc-50 shadow-pop transition-transform duration-200 dark:border-zinc-800 dark:bg-zinc-950 ${
            drawer ? "translate-x-0" : "-translate-x-full"
          }`}
          aria-label="Sessions"
        >
          <SessionSidebar
            sessions={sessions}
            activeKey={activeKey}
            onCreate={createSession}
            creating={creating}
            createError={createError}
            onClearCreateError={() => setCreateError(null)}
            onActivate={hub.activate}
            onBurnOne={burnOne}
            onBurnAll={burnAll}
            onNavigate={() => setSidebar("collapsed")}
            onClose={() => setSidebar("collapsed")}
          />
        </aside>
      </div>

      {/* ---------- SESSION LAYERS ---------- */}
      {sessions.length === 0 ? (
        <main className="page-bg flex h-full flex-1 items-center justify-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-100 px-3.5 py-1.5 font-mono text-xs text-zinc-600 dark:border-zinc-700/50 dark:bg-zinc-800/80 dark:text-zinc-300">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Preparing sessions…
          </span>
        </main>
      ) : (
        <div className="relative min-w-0 flex-1">
          {sessions.map((s) => {
            const isActive = s.key === activeKey;
            return (
              <div
                key={s.key}
                className="absolute inset-0"
                style={isActive ? undefined : { display: "none" }}
                aria-hidden={!isActive}
              >
                <Room
                  ref={(h) => {
                    if (h) handles.current.set(s.key, h);
                    else handles.current.delete(s.key);
                  }}
                  roomId={s.roomId}
                  sessionId={s.key}
                  onReport={hub.report}
                  onDead={burnOne}
                  uiActive={isActive}
                  sidebarVisible={sidebar === "open"}
                  onOpenSidebar={() => setSidebar("open")}
                  onExit={navigate.bind(null, "/")}
                />
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
