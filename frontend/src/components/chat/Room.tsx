// SHARD — room workspace. Wires the E2EE session to the chat UI:
// search, edit mode (↑ to edit last), pinning, polls, view-once media,
// drag & drop images, reply state, lightbox, destroyed-session screens.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { CircleAlert, Clock, DoorOpen, Flame, LoaderCircle, ShieldAlert, ShieldCheck, Zap } from "lucide-react";
import { useChatSession, type PurgeStats, type SessionPhase } from "../../hooks/useChatSession";
import type { ChatMessage } from "../../types/chat";
import { formatBytes } from "../../lib/fileSecurity";
import { useWebRTCCall } from "../../hooks/useWebRTCCall";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import { useSound } from "../../hooks/useSound";
import { playCallTone, stopCallTone } from "../../lib/audioBus";
import { CallStage } from "./CallStage";
import { ChatHeader } from "./ChatHeader";
import { MessageList } from "./MessageList";
import { InputBar } from "./InputBar";
import { MediaViewer } from "./MediaViewer";
import { PinnedBar } from "./PinnedBar";
import { ShortcutsModal } from "./ShortcutsModal";
import Navbar from "../Navbar";
import Footer from "../Footer";
import { navigate } from "../../App";

export type RoomHandle = {
  /** Imperative burn used by the hub's "Burn All" and per-card ×. */
  burn: () => void;
};

interface RoomProps {
  roomId: string;
  /** Stable hub key when the Room lives under the multi-session host.
   *  Reporting and sidebar callbacks are only wired when present. */
  sessionId?: string;
  /** Phase + unread reporting channel up to the hub. */
  onReport?: (key: string, patch: { phase?: SessionPhase; peerMessage?: boolean }) => void;
  /** Fired once the session reaches a terminal phase (burned/gone/full). */
  onDead?: (key: string) => void;
  /** False for background layers: global listeners and overlays stand down
   *  so two mounted Rooms never fight over paste, "?" or the URL. */
  uiActive?: boolean;
  /** Whether the session sidebar is currently shown (desktop rail). */
  sidebarVisible?: boolean;
  onOpenSidebar?: () => void;
  onExit: () => void;
}

/** Live purge telemetry for the burned-screen badge: the real byte/message
 *  count this tab measured and wiped at session end — or the zero state for
 *  a link that never stored anything here. */
function purgeBadgeText(stats: PurgeStats | null): string {
  if (!stats || stats.messages === 0) return "Memory Purged (0 Bytes) · Keys Destroyed";
  return `Memory Purged (~${formatBytes(stats.bytes)}) · ${stats.messages} message${
    stats.messages === 1 ? "" : "s"
  } wiped · Keys Destroyed`;
}

/** The ways a one-time session can end. The row the client actually
 *  detected (see PurgeStats.reason) is highlighted as the detected cause. */
const BURN_CAUSES = [
  { reason: "timer", icon: Clock, text: "The session's lifetime timer expired." },
  { reason: "manual", icon: Flame, text: "A participant manually burned the session." },
  { reason: "peer-left", icon: DoorOpen, text: "A participant closed their browser tab." },
  { reason: "handshake", icon: ShieldAlert, text: "Cryptographic handshake failed — a downgrade or tampering attempt was refused." },
] as const;

export const Room = forwardRef<RoomHandle, RoomProps>(function Room(
  { roomId, sessionId, onReport, onDead, uiActive = true, sidebarVisible = false, onOpenSidebar, onExit },
  ref,
) {
  const s = useChatSession(roomId);
  const call = useWebRTCCall({
    // Gate on verified: a dead /room/:id link must never spin up ICE
    // gathering or media devices before the room is confirmed to exist.
    enabled: s.verified && s.phase !== "gone",
    dead: s.phase === "burned" || s.phase === "gone",
    expiresAt: s.expiresAt,
    roomId,
    send: s.sendSignal,
    on: s.onSignal,
  });
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [hitIndex, setHitIndex] = useState(0);
  /** Any input-dock panel (emoji / "+") is open — the list re-pins down. */
  const [inputPanelsOpen, setInputPanelsOpen] = useState(false);
  /** True until the peer joins and the E2EE channel is established. */
  const locked = s.phase !== "secure";
  /** Quiet security-guard rejections (from the session hook). */
  const securityNotice = s.securityNotice;
  /** InputBar-registered hook: pushes dropped photos into the dock queue. */
  const addToQueueRef = useRef<((files: File[]) => void) | null>(null);
  const { soundEnabled, toggleSound } = useSound();

  // Imperative handle for the host: burn = the same path as the header's
  // burn button (hangup first, then the server-side burn).
  const burnRef = useRef<() => void>(() => {});
  burnRef.current = () => {
    call.hangup();
    s.burnRoom();
  };
  useImperativeHandle(ref, () => ({ burn: () => burnRef.current() }), []);

  // Mirror the live session state up to the hub so the sidebar stays honest
  // about background sessions: phase dots, expiry, unread counters.
  const phaseRef = useRef<SessionPhase>(s.phase);
  phaseRef.current = s.phase;
  const lastMsgCountRef = useRef(s.messages.length);
  useEffect(() => {
    if (!sessionId || !onReport) return;
    const grew = s.messages.length > lastMsgCountRef.current;
    lastMsgCountRef.current = s.messages.length;
    const last = s.messages[s.messages.length - 1];
    onReport(sessionId, {
      phase: s.phase,
      peerMessage: Boolean(grew && last && last.sender === "peer" && s.phase === "secure"),
    });
  }, [sessionId, onReport, s.phase, s.messages]);

  // Terminal phases remove the session from the hub (the host unmounts this
  // Room); a standalone Room just ignores it.
  const deadRef = useRef(onDead);
  deadRef.current = onDead;
  useEffect(() => {
    if (sessionId && onDead && (s.phase === "burned" || s.phase === "gone" || s.phase === "room_full")) {
      deadRef.current?.(sessionId);
    }
  }, [sessionId, onDead, s.phase]);

  // phones: while the on-screen keyboard is open the chat shell shrinks to
  // the visible viewport (100dvh − keyboard), so the composer and the last
  // messages stay above the keyboard — standard messenger behavior. On
  // desktop the inset is always 0 and the inline style never applies.
  const { keyboardInset, keyboardActive } = useKeyboardInset();

  // UX guard: the session is memory-only, so a refresh
  // or tab close destroys it forever. The listener is removed on the
  // graceful path (Burn to destroyed screen to exit) via the phase condition.
  // Under the multi-session host the guard is owned by RoomHost (it covers
  // every parallel session in one dialog), so standalone Rooms only.
  useEffect(() => {
    if (!uiActive) return; // the host guards once for all layers
    if (!s.verified) return; // nothing to protect before the room exists
    if (s.phase === "burned" || s.phase === "gone") return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue =
        "Warning: closing the tab or refreshing the page destroys the session and all messages forever. Are you sure?";
      return e.returnValue;
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [s.phase, uiActive]);

  // Zero-trace hygiene: strip any stray query/hash from the address bar.
  // Only the active layer may own the URL — two Rooms would otherwise fight
  // over replaceState on every render.
  useEffect(() => {
    if (!uiActive) return;
    window.history.replaceState(null, "", `/room/${roomId}`);
  }, [roomId, uiActive]);

  // "?" opens the shortcut reference (that IS Shift + /, so one check covers
  // both). Ignored inside a text field: typing "why?" into a message must
  // never summon a dialog over the composer. Stand-down when inactive: a
  // background layer must never pop a dialog over the visible one.
  useEffect(() => {
    if (!uiActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      setShortcutsOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [uiActive]);

  // Ring while an incoming call waits for the tap to accept, and stop the
  // moment it is accepted, declined or the call ends — otherwise the tone
  // would outlive the call it belongs to.
  useEffect(() => {
    if (call.phase === "incoming") {
      playCallTone();
      return () => stopCallTone();
    }
    stopCallTone();
    return undefined;
  }, [call.phase]);

  // Leaving the room must not leave a ring running in a tab nobody is
  // listening to.
  useEffect(() => () => stopCallTone(), []);


  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (locked) return; // peer not in yet: dropped files are ignored
      const files = [...e.dataTransfer.files];
      if (files.length === 0) return;
      // everything goes to the dock queue first: the security gate runs
      // here and rejected items stay visible with the reason.
      if (addToQueueRef.current) {
        addToQueueRef.current(files);
      } else {
        files.forEach((file) =>
          file.type.startsWith("image/")
            ? void s.sendImage(file, replyTo?.id)
            : void s.sendAttachment(file),
        );
      }
      setReplyTo(null);
    },
    [s, replyTo, locked],
  );

  const jumpTo = useCallback((id: string) => {
    document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // ↑ in the empty input opens the edit banner for the last self text message.
  const tryEditLast = useCallback(() => {
    if (editing) return;
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const m = s.messages[i]!;
      if (m.sender === "self" && m.body.kind === "text") {
        setEditing(m);
        return;
      }
    }
  }, [s.messages, editing]);

  const pinned = useMemo(() => s.messages.find((m) => m.id === s.pinnedId) ?? null, [s.messages, s.pinnedId]);
  const pinnedText = pinned
    ? pinned.body.kind === "text"
      ? pinned.body.text
      : pinned.body.kind === "poll"
        ? `Poll: ${pinned.body.question}`
        : ""
    : "";

  // search hits over text messages (question of polls included).
  const hits = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return s.messages.filter((m) => {
      const t = m.body.kind === "text" ? m.body.text : m.body.kind === "poll" ? m.body.question : "";
      return t.toLowerCase().includes(q);
    });
  }, [s.messages, search]);

  useEffect(() => setHitIndex(0), [search]);
  useEffect(() => {
    if (hits.length > 0) jumpTo(hits[Math.min(hitIndex, hits.length - 1)]!.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hitIndex, hits]);

  // A third participant never gets a seat: the socket hook has already stopped
  // every timer and network call, so this screen is terminal and stable. It sits
  // ABOVE the verified gate on purpose — the pre-flight probe is what detects
  // the full room, so gating on `verified` first would flash the empty chat
  // shell for a frame before this took over.
  if (s.phase === "room_full") {
    return (
      <div className="page-bg relative flex min-h-full flex-col transition-colors duration-200">
        <div
          aria-hidden
          className="page-grid pointer-events-none fixed inset-0 -z-10 transition-colors duration-200"
          style={{
            maskImage: "radial-gradient(ellipse 90% 60% at 50% 0%, black 30%, transparent 75%)",
            WebkitMaskImage: "radial-gradient(ellipse 90% 60% at 50% 0%, black 30%, transparent 75%)",
          }}
        />
        <Navbar />

        <main className="mx-auto max-w-md px-4 py-16 text-center">
          {/* Strict capacity plate — a measurement, not a slogan */}
          <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-100 px-3.5 py-1.5 font-mono text-xs text-zinc-600 dark:border-zinc-700/50 dark:bg-zinc-800/80 dark:text-zinc-300">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-zinc-500 dark:bg-zinc-400" />
            Access Denied · 2/2 Seats Occupied
          </span>

          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <ShieldAlert className="h-7 w-7 text-zinc-500 dark:text-zinc-400" aria-hidden />
          </span>

          <h1 className="mt-6 text-2xl font-bold text-zinc-900 dark:text-white">Session is Full</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
            This private channel is strictly limited to two participants. Both seats are currently
            occupied, and no additional connections are permitted.
          </p>

          <div className="mt-8 flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => navigate("/new")}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-black px-6 py-3 text-sm font-medium text-white transition-all duration-200 hover:bg-zinc-800 active:scale-[0.98] dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              <Zap className="h-4 w-4" aria-hidden />
              Create Your Own Session
            </button>
            <button
              type="button"
              onClick={() => navigate("/")}
              className="text-sm text-tertiary underline-offset-4 transition-colors duration-200 hover:text-heading hover:underline"
            >
              Back to Home
            </button>
          </div>
        </main>

        <Footer />
      </div>
    );
  }

  // Terminal screen for a standalone Room (no host): every parallel session
  // burns independently, so the hub already removed this layer — this full-
  // screen branch only runs when the Room mounts outside RoomHost.
  if (s.phase === "gone" || s.phase === "burned") {
    if (sessionId) return null; // hub removes the layer; no full-screen flash
    return (
      <div className="page-bg relative flex min-h-full flex-col transition-colors duration-200">
        {/* Fading dot grid: same canvas as the landing, brand continuity. */}
        <div
          aria-hidden
          className="page-grid pointer-events-none fixed inset-0 -z-10 transition-colors duration-200"
          style={{
            maskImage: "radial-gradient(ellipse 90% 60% at 50% 0%, black 30%, transparent 75%)",
            WebkitMaskImage: "radial-gradient(ellipse 90% 60% at 50% 0%, black 30%, transparent 75%)",
          }}
        />
        <Navbar />

        <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center px-4 py-16 text-center">
          {/* Strict technical status plate — a real measurement, not a slogan */}
          <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-100 px-3.5 py-1.5 font-mono text-xs text-zinc-600 dark:border-zinc-700/50 dark:bg-zinc-800/80 dark:text-zinc-300">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-zinc-500 dark:bg-zinc-400" />
            {purgeBadgeText(s.purgeStats)}
          </span>

          {/* Guarantee mark */}
          <span className="flex h-16 w-16 items-center justify-center rounded-full border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <ShieldCheck className="h-7 w-7 text-zinc-500 dark:text-zinc-400" aria-hidden />
          </span>

          <h1 className="mt-6 text-2xl font-bold text-zinc-900 dark:text-white">Session Burned</h1>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
            This communication channel no longer exists. All messages, encryption keys, and files have been
            permanently wiped from volatile memory.
          </p>

          {/* Why the session is gone — the detected cause is highlighted */}
          <div className="my-8 w-full space-y-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-5 text-left text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300">
            <ul className="space-y-1.5">
              {BURN_CAUSES.map(({ reason, icon: Icon, text }) => {
                const isCause = s.purgeStats?.reason === reason;
                return (
                  <li
                    key={reason}
                    className={`-mx-2 flex items-start gap-3 rounded-lg px-2 py-1.5 ${
                      isCause ? "bg-zinc-200/70 dark:bg-zinc-800/70" : ""
                    }`}
                  >
                    <Icon
                      className={`mt-0.5 h-4 w-4 shrink-0 ${
                        isCause ? "text-zinc-600 dark:text-zinc-300" : "text-zinc-400 dark:text-zinc-500"
                      }`}
                      aria-hidden
                    />
                    <span className={`flex-1 ${isCause ? "font-medium text-zinc-900 dark:text-white" : ""}`}>
                      {text}
                    </span>
                    {isCause && (
                      <span className="mt-0.5 rounded-full border border-zinc-300 px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
                        cause
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 border-t border-zinc-200 pt-3 text-xs text-zinc-400 dark:border-zinc-800">
              Data recovery is mathematically and technically impossible.
            </p>
          </div>

          <button
            type="button"
            onClick={() => navigate("/new")}
            className="inline-flex items-center gap-2 rounded-full bg-black px-6 py-3 text-sm font-medium text-white transition-colors duration-200 hover:bg-zinc-800 active:scale-[0.98] dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            <Zap className="h-4 w-4" aria-hidden />
            Create New Session
          </button>
          <button
            type="button"
            onClick={onExit}
            className="mt-4 block text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-white"
          >
            Back to Home
          </button>
        </main>

        <Footer />
      </div>
    );
  }

  // re-flight gate: until a REST probe confirms the room exists, show a
  // calm branded placeholder — never the chat UI itself (no flash of a
  // head chat) and never a bare white page while the probe is in flight.
  if (!s.verified) {
    return (
      <main
        className="page-bg relative flex h-full flex-col items-center justify-center transition-colors duration-200"
        aria-busy="true"
      >
        <div
          aria-hidden
          className="page-grid pointer-events-none fixed inset-0 -z-10 transition-colors duration-200"
          style={{
            maskImage: "radial-gradient(ellipse 90% 60% at 50% 0%, black 30%, transparent 75%)",
            WebkitMaskImage: "radial-gradient(ellipse 90% 60% at 50% 0%, black 30%, transparent 75%)",
          }}
        />
        <span className="flex h-16 w-16 items-center justify-center rounded-full border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <ShieldCheck className="h-7 w-7 text-zinc-500 dark:text-zinc-400" aria-hidden />
        </span>
        <span className="mt-6 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-100 px-3.5 py-1.5 font-mono text-xs text-zinc-600 dark:border-zinc-700/50 dark:bg-zinc-800/80 dark:text-zinc-300">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Checking the session…
        </span>
        <p className="mt-4 max-w-xs text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
          The relay confirms this one-time session still exists — nothing opens before the check.
        </p>
      </main>
    );
  }

  const inCall = call.phase !== "idle";
  const callTakesOver = inCall && !call.minimized;

  return (
    <main
      className="page-bg relative flex h-full flex-row transition-colors duration-200"
      style={
        keyboardActive && keyboardInset > 0
          ? { height: `calc(100dvh - ${keyboardInset}px)` }
          : undefined
      }
      onDragOver={uiActive ? (e) => { e.preventDefault(); setDragOver(true); } : undefined}
      onDragLeave={uiActive ? () => setDragOver(false) : undefined}
      onDrop={uiActive ? onDrop : undefined}
    >
      <CallStage {...call} />

      <div className={`flex min-h-0 flex-1 flex-col ${callTakesOver ? "hidden" : ""}`}>
        <ChatHeader
          phase={s.phase}
          fingerprint={s.fingerprint}
          expiresAt={s.expiresAt}
          actionsLocked={locked}
          sidebarVisible={sidebarVisible}
          onToggleSidebar={onOpenSidebar}
          searchOpen={searchOpen}
          searchQuery={search}
          searchMatchCount={hits.length}
          searchActiveIndex={Math.min(hitIndex, Math.max(0, hits.length - 1))}
          onSearchQuery={setSearch}
          onSearchPrev={() => setHitIndex((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0))}
          onSearchNext={() => setHitIndex((i) => (hits.length ? (i + 1) % hits.length : 0))}
          onSearchClose={() => {
            setSearchOpen(false);
            setSearch("");
            setHitIndex(0);
          }}
          onToggleSearch={() => {
            setSearchOpen((v) => {
              if (v) {
                setSearch("");
                setHitIndex(0);
              }
              return !v;
            });
          }}
          onBurn={() => {
            call.hangup();
            s.burnRoom();
          }}
          canCall={s.phase === "secure" && call.remotePeerReady}
          inCall={inCall}
          onAudioCall={() => call.startCall("audio")}
          onVideoCall={() => call.startCall("video")}
          soundEnabled={soundEnabled}
          onToggleSound={toggleSound}
        />

        {pinned && pinnedText && (
          <PinnedBar text={pinnedText} onJump={() => jumpTo(pinned.id)} onUnpin={() => s.pinMessage(null)} />
        )}

        {dragOver && (
          <div className="pointer-events-none absolute inset-4 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-line-strong bg-surface/60 backdrop-blur-sm">
            <p className="text-sm font-medium text-heading">
              {locked ? "Your peer hasn't joined yet — sending is unavailable" : "Drop to queue the file for sending"}
            </p>
          </div>
        )}

        <MessageList
          messages={s.messages}
          peerTyping={s.peerTyping}
          transfers={s.transfers}
          dockPanelsOpen={inputPanelsOpen}
          search={searchOpen ? search : ""}
          highlightId={hits.length > 0 ? hits[Math.min(hitIndex, hits.length - 1)]!.id : null}
          onBurnViewOnce={(id) => {
            // wipe from memory: remove the message entirely (both sides run
            // their own clocks; content is never persisted anywhere).
            s.deleteMessage(id);
          }}
          onReply={setReplyTo}
          onReact={s.toggleReaction}
          onEdit={(id, text) => {
            const m = s.messages.find((x) => x.id === id);
            if (m) setEditing(m);
            void text;
          }}
          onDelete={s.deleteMessage}
          onPin={(id) => s.pinMessage(id)}
          onVote={s.votePoll}
          onOpenViewOnce={s.openViewOnce}
          onOpenImage={setLightbox}
          onJumpTo={jumpTo}
          markRead={s.markRead}
        />

        {securityNotice && (
          <div className="z-40 flex justify-center px-4 pb-1">
            <div
              role="status"
              className="card shadow-pop flex max-w-md items-center gap-2 rounded-full px-3.5 py-2 text-xs text-heading"
            >
              <CircleAlert className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400" aria-hidden />
              {securityNotice}
            </div>
          </div>
        )}

        <InputBar
          disabled={locked}
          capturePaste={uiActive}
          replyTo={replyTo}
          editing={editing}
          onPanelsOpenChange={setInputPanelsOpen}
          onSecurityNotice={s.reportSecurity}
          registerAddToQueue={(fn) => {
            addToQueueRef.current = fn;
          }}
          onCancelReply={() => setReplyTo(null)}
          onCancelEdit={() => setEditing(null)}
          onSendText={(text) => {
            s.sendText(text, replyTo?.id);
            setReplyTo(null);
          }}
          onEditDone={(id, text) => {
            s.editMessage(id, text);
            setEditing(null);
          }}
          onSendQueue={(items, caption) => {
            // caption rides the LAST photo: bubble = image + text together.
            items.forEach((it, i) => {
              void s.sendImage(it.file, replyTo?.id, it.viewOnce, i === items.length - 1 ? caption : undefined);
            });
            setReplyTo(null);
          }}
          onSendAttachment={(file, caption) => void s.sendAttachment(file, caption)}
          onSendAudio={(r) => void s.sendAudio(r.blob, r.wave, r.durationMs)}
          onSendPoll={(question, options) => s.sendPoll(question, options)}
          onTyping={s.notifyTyping}
          // arrowUp opens edit mode when the input is empty.
          onEditLast={tryEditLast}
        />
      </div>

      {lightbox && uiActive && <MediaViewer imageSrc={lightbox} onClose={() => setLightbox(null)} />}
      {shortcutsOpen && uiActive && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
    </main>
  );
});
