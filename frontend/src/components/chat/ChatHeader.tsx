// SHARD — floating top row. Left: SHARD wordmark with the connection status
// beneath it (no logo tile). Middle: the search pill, styled like the input
// dock, when search is open. Right: a slim controls capsule - call, video,
// search toggle and a "⋯" menu holding countdown, safety fingerprint, burn.
import { useEffect, useRef, useState } from "react";
import { Flame, MoreVertical, Phone, Search, ShieldCheck, Video } from "lucide-react";
import { formatCountdown } from "../../lib/utils";
import type { SessionPhase } from "../../hooks/useChatSession";
import { SearchBar } from "./SearchBar";

interface ChatHeaderProps {
  phase: SessionPhase;
  fingerprint: [string, string, string, string] | null;
  expiresAt: number | null;
  /** True until the peer joins and E2EE is up: chat features stay off. */
  actionsLocked: boolean;
  searchOpen: boolean;
  /** Search pill props (rendered between brand and controls when open). */
  searchQuery: string;
  searchMatchCount: number;
  searchActiveIndex: number;
  onSearchQuery: (q: string) => void;
  onSearchPrev: () => void;
  onSearchNext: () => void;
  onSearchClose: () => void;
  onToggleSearch: () => void;
  onBurn: () => void;
  canCall: boolean;
  inCall: boolean;
  onAudioCall: () => void;
  onVideoCall: () => void;
}

// Same look as the dock's round icon buttons (single visual language).
const iconBtn =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-tertiary transition-all duration-150 hover:bg-black/[0.06] hover:text-heading active:scale-90 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-strong dark:hover:bg-white/10";

/** Compact connection label under the wordmark. */
function StatusLine({ phase }: { phase: SessionPhase }) {
  if (phase === "secure") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
        Secure channel
      </span>
    );
  }
  if (phase === "burned" || phase === "gone") {
    return <span className="text-[11px] text-tertiary">Session destroyed</span>;
  }
  if (phase === "peer_away") {
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-amber-600 dark:text-amber-400">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500 dark:bg-amber-400" />
        Peer disconnected — waiting
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-secondary">
      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-line-strong" />
      {phase === "exchanging" ? "Exchanging keys…" : "Waiting for your peer"}
    </span>
  );
}

export function ChatHeader({
  phase,
  fingerprint,
  expiresAt,
  actionsLocked,
  searchOpen,
  searchQuery,
  searchMatchCount,
  searchActiveIndex,
  onSearchQuery,
  onSearchPrev,
  onSearchNext,
  onSearchClose,
  onToggleSearch,
  onBurn,
  canCall,
  inCall,
  onAudioCall,
  onVideoCall,
}: ChatHeaderProps) {
  const [kebabOpen, setKebabOpen] = useState(false);
  const [msLeft, setMsLeft] = useState<number | null>(null);
  const kebabWrapRef = useRef<HTMLDivElement>(null);

  // local 1s ticker for the countdown (lives inside the ⋯ menu).
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setMsLeft(expiresAt - Date.now());
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  // ⋯ menu: close on outside click / Escape.
  useEffect(() => {
    if (!kebabOpen) return;
    const onDown = (e: MouseEvent) => {
      if (kebabWrapRef.current && !kebabWrapRef.current.contains(e.target as Node)) setKebabOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setKebabOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [kebabOpen]);

  const burned = phase === "burned" || phase === "gone";

  return (
    <header className="safe-px relative z-20 flex w-full items-center gap-3 pb-1 pt-3">
      {/* Brand: wordmark + connection status, pinned to the very left edge */}
      <div className="shrink-0 leading-tight">
        <p className="text-[13px] font-semibold tracking-wider text-heading">SHARD</p>
        <div className="mt-0.5">
          <StatusLine phase={phase} />
        </div>
      </div>

      {/* Middle: the search pill takes the remaining width when open */}
      {searchOpen && (
        <SearchBar
          query={searchQuery}
          onQuery={onSearchQuery}
          matchCount={searchMatchCount}
          activeIndex={searchActiveIndex}
          onPrev={onSearchPrev}
          onNext={onSearchNext}
          onClose={onSearchClose}
        />
      )}

      {/* Right: slim controls capsule */}
      <div className="card ml-auto flex shrink-0 items-center gap-0.5 rounded-3xl px-1.5 py-1.5">
        <button
          type="button"
          onClick={onAudioCall}
          disabled={!canCall || inCall}
          aria-label="Voice call"
          title="Voice call"
          className={iconBtn}
        >
          <Phone className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onVideoCall}
          disabled={!canCall || inCall}
          aria-label="Video call"
          title="Video call"
          className={iconBtn}
        >
          <Video className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onToggleSearch}
          disabled={actionsLocked}
          aria-label="Search chat"
          title={actionsLocked ? "Search unlocks when your peer joins" : "Search chat"}
          aria-pressed={searchOpen}
          className={searchOpen ? `${iconBtn} bg-black/[0.08] text-heading dark:bg-white/10` : iconBtn}
        >
          <Search className="h-4 w-4" aria-hidden />
        </button>

        {/* ⋯ menu: countdown, safety fingerprint, burn */}
        <div ref={kebabWrapRef} className="relative">
          <button
            type="button"
            onClick={() => setKebabOpen((v) => !v)}
            aria-label="More"
            title="More"
            aria-expanded={kebabOpen}
            className={kebabOpen ? `${iconBtn} bg-black/[0.08] text-heading dark:bg-white/10` : iconBtn}
          >
            <MoreVertical className="h-4 w-4" aria-hidden />
          </button>

          {kebabOpen && (
            <div className="card shadow-pop absolute right-0 top-full z-30 mt-2 w-72 rounded-2xl p-2">
              {/* Countdown row */}
              <div className="flex items-center gap-2.5 rounded-xl px-2.5 py-2">
                <Flame className="h-4 w-4 shrink-0 text-tertiary" aria-hidden />
                <span className="min-w-0 flex-1 text-sm text-secondary">Self-destructs in</span>
                {msLeft !== null && msLeft > 0 && !burned ? (
                  <span className="well rounded-full px-2 py-0.5 font-mono text-[11px] font-medium text-secondary">
                    {formatCountdown(msLeft)}
                  </span>
                ) : (
                  <span className="text-[11px] text-tertiary">—</span>
                )}
              </div>

              <div className="my-1 border-t border-line" />

              {/* Safety fingerprint section */}
              <div className="px-2.5 pb-1 pt-1.5">
                <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-tertiary">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Safety code
                </p>
                {fingerprint ? (
                  <>
                    <div className="mt-1.5 flex items-center gap-1 text-xl">
                      {fingerprint.map((e, i) => (
                        <span key={i}>{e}</span>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-tertiary">
                      Derived from the shared ECDH secret. Compare with your peer over another channel: if they match, the
                      channel is genuine.
                    </p>
                  </>
                ) : (
                  <p className="mt-1.5 text-[11px] text-tertiary">Appears once encryption is established.</p>
                )}
              </div>

              <div className="my-1 border-t border-line" />

              {/* Burn action */}
              <button
                type="button"
                onClick={() => {
                  setKebabOpen(false);
                  onBurn();
                }}
                disabled={burned}
                className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-secondary transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:pointer-events-none disabled:opacity-40 dark:hover:text-red-400"
              >
                <Flame className="h-4 w-4 shrink-0" aria-hidden />
                <span className="flex-1">Burn session</span>
                <span className="text-[10px] text-tertiary">no way back</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
