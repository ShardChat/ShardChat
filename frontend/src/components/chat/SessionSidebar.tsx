// SHARD — the multi-session sidebar (desktop rail / mobile drawer). The
// strict Zinc look from the spec: hairline border, translucent surface,
// backdrop blur. The live countdown per card is a shared 1s ticker so every
// session's remaining time breathes even while its chat is off-screen.
import { useEffect, useState } from "react";
import { Flame, LoaderCircle, Plus, X } from "lucide-react";
import { CrystalLogo } from "../CrystalLogo";
import { MAX_SESSIONS, shortRoomId } from "../../lib/sessionHub";
import type { HubSession } from "../../hooks/useSessionHub";

interface SessionSidebarProps {
  sessions: HubSession[];
  activeKey: string | null;
  /** Fires the POST /api/rooms round-trip; resolves when the session is in. */
  onCreate: (ttlMinutes: number) => Promise<void>;
  /** True while the POST /api/rooms round-trip is in flight. */
  creating: boolean;
  /** Error from the last create attempt (null clears the row). */
  createError: string | null;
  onActivate: (key: string) => void;
  onBurnOne: (key: string) => void;
  onBurnAll: () => void;
  /** Resets a failed create attempt (closing the picker row's error). */
  onClearCreateError: () => void;
  /** Mobile drawer: tapping a card also slides the panel away. */
  onNavigate: () => void;
  onClose: () => void;
}

const TTL_CHOICES = [
  { minutes: 30, label: "30m" },
  { minutes: 120, label: "2h" },
  { minutes: 1440, label: "24h" },
] as const;

/** MM:SS countdown under ten minutes, M:SS above — reads fast in a narrow rail. */
function formatMss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function SessionSidebar({
  sessions,
  activeKey,
  onCreate,
  creating,
  createError,
  onActivate,
  onBurnOne,
  onBurnAll,
  onClearCreateError,
  onNavigate,
  onClose,
}: SessionSidebarProps) {
  const [ttl, setTtl] = useState<number>(30);
  const [now, setNow] = useState(Date.now);
  /** The compact [+ New Session] button expands into the TTL picker. */
  const [pickerOpen, setPickerOpen] = useState(false);

  // One ticker drives every card's countdown.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const full = sessions.length >= MAX_SESSIONS;

  return (
    <div className="flex h-full flex-col justify-between p-3">
      {/* ---------- TOP: brand, collapse, new session ---------- */}
      <div className="min-h-0 flex-1">
        <div className="mb-3 flex items-center gap-2 px-1">
          <CrystalLogo className="h-5 w-5" />
          <span className="flex-1 text-[13px] font-semibold tracking-wider text-heading">SHARD</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Hide sessions panel"
            title="Hide panel (Ctrl+\)"
            className="rounded-lg p-1.5 text-tertiary transition-colors duration-150 hover:bg-black/[0.06] hover:text-heading dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {/* New session: the compact button expands into a TTL picker that
            generates the invite link via POST /api/rooms, then collapses. */}
        <div className="px-1">
          {!pickerOpen && !creating && !createError ? (
            <button
              type="button"
              disabled={full}
              onClick={() => setPickerOpen(true)}
              title={full ? `At most ${MAX_SESSIONS} parallel sessions` : "Create a new parallel session"}
              className="card card-hover flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-heading transition-all duration-200 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
            >
              <Plus className="h-4 w-4" aria-hidden />
              New Session
            </button>
          ) : (
            <div className="card flex flex-col gap-2 rounded-xl p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wider text-tertiary">Burn time</span>
                {creating ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin text-tertiary" aria-hidden />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setPickerOpen(false);
                      onClearCreateError();
                    }}
                    aria-label="Cancel new session"
                    className="rounded-md p-0.5 text-tertiary transition-colors hover:text-heading"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-1">
                {TTL_CHOICES.map((opt) => (
                  <button
                    key={opt.minutes}
                    type="button"
                    onClick={() => setTtl(opt.minutes)}
                    className={`rounded-lg px-1 py-1.5 text-xs transition-colors duration-150 ${
                      ttl === opt.minutes
                        ? "bg-zinc-200 font-semibold text-zinc-900 dark:bg-zinc-800 dark:text-white"
                        : "text-secondary hover:bg-zinc-100 dark:hover:bg-zinc-900/60"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled={creating}
                onClick={() => {
                  void onCreate(ttl)
                    .then(() => setPickerOpen(false))
                    .catch(() => {
                      /* the error row below explains; the picker stays open */
                    });
                }}
                className="flex items-center justify-center gap-1.5 rounded-full bg-black px-3 py-1.5 text-xs font-medium text-white transition-all duration-200 hover:bg-zinc-800 active:scale-[0.98] disabled:opacity-60 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Create
              </button>
            </div>
          )}
          {createError && (
            <p role="alert" className="mt-1.5 px-1 text-[11px] leading-snug text-red-600 dark:text-red-400">
              {createError}
            </p>
          )}
        </div>

        {/* ---------- SESSION LIST ---------- */}
        <div className="mt-3 space-y-1.5 overflow-y-auto" aria-label="Active sessions">
          {sessions.length === 0 && (
            <p className="px-1 pt-6 text-center text-xs leading-relaxed text-tertiary">
              No active sessions.
              <br />
              Create one to start chatting.
            </p>
          )}
          {sessions.map((s) => {
            const active = s.key === activeKey;
            const msLeft = s.expiresAt - now;
            const live = s.phase === "secure" || s.phase === "exchanging";
            const waiting = s.phase === "connecting" || s.phase === "waiting";
            const dead = s.phase === "burned" || s.phase === "gone" || s.phase === "room_full";
            return (
              <div
                key={s.key}
                role="button"
                tabIndex={0}
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  onActivate(s.key);
                  onNavigate();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onActivate(s.key);
                    onNavigate();
                  }
                }}
                className={`group relative cursor-pointer rounded-xl border p-2.5 transition-all duration-200 ${
                  active
                    ? "border-zinc-300 bg-zinc-200 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-white"
                    : "border-transparent hover:border-transparent hover:bg-zinc-100 dark:hover:bg-zinc-900/60"
                }`}
              >
                <div className="flex items-center gap-2">
                  {/* status dot: green = live, pulsing = waiting, gray = dead */}
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      dead
                        ? "bg-zinc-400 dark:bg-zinc-600"
                        : live
                          ? "bg-emerald-500 dark:bg-emerald-400"
                          : "animate-pulse bg-amber-500 dark:bg-amber-400"
                    }`}
                  />
                  <span className={`min-w-0 flex-1 truncate font-mono text-[13px] font-medium ${active ? "" : "text-secondary group-hover:text-heading"}`}>
                    #{shortRoomId(s.roomId)}
                  </span>
                  {/* unread badge */}
                  {s.unread > 0 && (
                    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-600 px-1 text-[10px] font-semibold text-white dark:bg-emerald-500">
                      {s.unread > 9 ? "9+" : s.unread}
                    </span>
                  )}
                  {/* per-session burn: appears on hover / keyboard focus */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onBurnOne(s.key);
                    }}
                    aria-label={`Burn session #${shortRoomId(s.roomId)}`}
                    title="Burn this session"
                    className="rounded-md p-0.5 text-tertiary opacity-0 transition-opacity duration-150 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:text-red-400"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
                <div className="mt-1 flex items-center gap-2 pl-3.5">
                  <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-tertiary">
                    {dead ? "Ended" : live ? "Connected" : waiting ? "Waiting" : "Away"}
                  </span>
                  <span className="ml-auto font-mono text-[10px] tabular-nums text-tertiary">
                    {dead ? "—" : formatMss(msLeft)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------- BOTTOM: mass burn ---------- */}
      <div className="mt-3 shrink-0 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <button
          type="button"
          disabled={sessions.length === 0}
          onClick={onBurnAll}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 px-3 py-2 text-sm font-medium text-red-600 transition-all duration-200 hover:border-red-300 hover:bg-red-500/10 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 dark:border-zinc-800 dark:text-red-400 dark:hover:border-red-500/30"
        >
          <Flame className="h-4 w-4" aria-hidden />
          Burn All Sessions
        </button>
      </div>
    </div>
  );
}
