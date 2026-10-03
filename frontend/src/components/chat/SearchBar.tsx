// SHARD — in-chat search: a floating well-pill styled like the input dock,
// rendered in the top row between the brand badge and the controls capsule.
// match counter + prev/next navigation + Esc to close; filtering/highlighting
// happens in the parent.
import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

interface SearchBarProps {
  query: string;
  onQuery: (q: string) => void;
  matchCount: number;
  activeIndex: number; // 0-based
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

// Matches the dock's icon-button language.
const iconBtn =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-tertiary transition-all duration-150 hover:bg-black/[0.06] hover:text-heading active:scale-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-strong dark:hover:bg-white/10";

export function SearchBar({ query, onQuery, matchCount, activeIndex, onPrev, onNext, onClose }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="well flex min-w-0 flex-1 items-center gap-1 rounded-3xl p-1 transition-colors focus-within:border-line-strong">
      <Search className="ml-2 h-4 w-4 shrink-0 text-tertiary" aria-hidden />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? onPrev() : onNext(); }
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
        }}
        placeholder="Search messages…"
        className="min-h-[32px] min-w-0 flex-1 bg-transparent px-1 text-sm text-heading placeholder:text-tertiary focus:outline-none"
        aria-label="Search messages"
      />
      <span className="shrink-0 pr-1 font-mono text-[11px] text-tertiary" aria-live="polite">
        {matchCount > 0 ? `${activeIndex + 1} / ${matchCount}` : query ? "none" : "0 / 0"}
      </span>
      <button type="button" onClick={onPrev} aria-label="Previous match" title="Previous (Shift+Enter)" className={iconBtn}>
        <ChevronUp className="h-4 w-4" aria-hidden />
      </button>
      <button type="button" onClick={onNext} aria-label="Next match" title="Next (Enter)" className={iconBtn}>
        <ChevronDown className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close search"
        title="Close (Esc)"
        className={`${iconBtn} bg-black/[0.06] text-secondary hover:text-heading dark:bg-white/10`}
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
