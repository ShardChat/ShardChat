// SHARD — pinned-message bar: a floating card under the header, styled with
// the same tokens as the input dock. Pin icon tile, jump-to-message text,
// unpin button. One pinned message per room.
import { Pin, X } from "lucide-react";

interface PinnedBarProps {
  text: string;
  onJump: () => void;
  onUnpin: () => void;
}

export function PinnedBar({ text, onJump, onUnpin }: PinnedBarProps) {
  return (
    <div className="px-4 pb-1 pt-2">
      <div className="card mx-auto flex w-full max-w-3xl items-center gap-2.5 rounded-2xl px-2.5 py-1.5">
        <span className="well flex h-7 w-7 shrink-0 items-center justify-center rounded-full" title="Pinned message">
          <Pin className="h-3.5 w-3.5 text-tertiary" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-[10px] font-medium uppercase tracking-wider text-tertiary">Pinned message</p>
          <button
            type="button"
            onClick={onJump}
            className="block w-full truncate text-left text-xs text-secondary transition-colors hover:text-heading"
            title="Jump to message"
          >
            {text}
          </button>
        </div>
        <button
          type="button"
          onClick={onUnpin}
          aria-label="Unpin message"
          title="Unpin"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-tertiary transition-all duration-150 hover:bg-black/[0.06] hover:text-heading active:scale-90 dark:hover:bg-white/10"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
