// SHARD — poll message: question, 2–4 options with animated vote bars,
// click-to-vote (self votes toggle/move), live peer vote sync via WS.
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
    <div className="min-w-[16rem]">
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
              className="group relative overflow-hidden rounded-lg border border-line bg-sunken/60 px-3 py-2 text-left transition-colors hover:border-line-strong"
              role="button"
              aria-pressed={mine}
            >
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-zinc-400/25 transition-[width] duration-500 ease-out dark:bg-zinc-500/30"
                style={{ width: `${pct}%` }}
              />
              <span className="relative flex items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-center gap-1.5">
                  {mine && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />}
                  <span className="truncate">{opt}</span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-tertiary">{pct}%</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-tertiary">
        {total === 0 ? "No votes yet" : `${total} ${total === 1 ? "vote" : "votes"}`} · E2EE
      </p>
    </div>
  );
}
