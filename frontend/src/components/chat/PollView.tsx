// SHARD — poll message: question, 2–4 options with animated vote bars,
// tap-to-vote (self votes toggle/move), live peer vote sync via WS.
// Mobile: no fixed min width (the old min-w-[16rem] overflowed narrow
// bubbles — phones cap the bubble at ~88% of a 360px viewport), 44px tap
// targets, and wrapping labels instead of truncate.
import { Check } from "lucide-react";
import type { PollBody } from "../../types/chat";

interface PollViewProps {
  body: PollBody;
  onVote: (optionIndex: number) => void;
}

export function PollView({ body, onVote }: PollViewProps) {
  const total = Object.values(body.votes).reduce((n, arr) => n + arr.length, 0);
  const myIndex = body.options.findIndex((_, i) => (body.votes[i] ?? []).includes("self"));

  return (
    <div className="min-w-0 text-left">
      <p className="mb-2.5 font-medium leading-snug">{body.question}</p>
      <div className="flex flex-col gap-1.5">
        {body.options.map((opt, i) => {
          const voters = body.votes[i] ?? [];
          const pct = total > 0 ? Math.round((voters.length / total) * 100) : 0;
          const mine = myIndex === i;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onVote(i)}
              className="relative min-h-[44px] overflow-hidden rounded-lg border border-line bg-sunken/60 text-left transition-colors hover:border-line-strong active:bg-black/[0.04] dark:active:bg-white/[0.06]"
              aria-pressed={mine}
            >
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-zinc-400/25 transition-[width] duration-500 ease-out dark:bg-zinc-500/30"
                style={{ width: `${pct}%` }}
              />
              <span className="relative flex min-h-[44px] items-center justify-between gap-2 px-3 py-1.5 text-sm">
                <span className="flex min-w-0 items-center gap-1.5">
                  {mine && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />}
                  <span className="whitespace-normal break-words">{opt}</span>
                </span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-tertiary">{pct}%</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-tertiary">
        {total === 0 ? "No votes yet" : `${total} ${total === 1 ? "vote" : "votes"} · E2EE`}
      </p>
    </div>
  );
}
