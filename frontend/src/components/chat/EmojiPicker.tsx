// SHARD — compact emoji picker for the input dock: a small grid of popular
// emoji grouped by category. Pure React, no heavy libraries.
// rendered in normal flow by the consumer (right-aligned above the input
// pill), so it never overlaps the photo queue or other dock panels.
import { useEffect, useRef } from "react";

const CATEGORIES: Array<{ name: string; emoji: string[] }> = [
  {
    name: "Smileys",
    emoji: ["😀", "😁", "😂", "🤣", "😊", "😍", "😘", "😎", "🤔", "😅", "😴", "🥲", "😭", "😡", "🤯", "🥳"],
  },
  {
    name: "Gestures",
    emoji: ["👍", "👎", "👌", "✌️", "🤝", "🙏", "💪", "👏"],
  },
  {
    name: "Symbols",
    emoji: ["❤️", "🔥", "✨", "⭐", "🎉", "💯", "⚡", "✅", "❌", "❓", "❗", "🔒"],
  },
  {
    name: "Other",
    emoji: ["☕", "🍕", "🎮", "🎧", "💡", "📎", "🚀", "🌙"],
  },
];

interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onPick, onClose }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      // Clicks on the toggle button are handled by its own onClick;
      // swallowing them here would make the button unable to close the panel.
      if (target?.closest?.("[data-emoji-toggle]")) return;
      if (ref.current && !ref.current.contains(target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="card shadow-pop w-64 rounded-2xl p-2.5"
      role="dialog"
      aria-label="Emoji panel"
    >
      {CATEGORIES.map((cat) => (
        <div key={cat.name} className="mb-1.5 last:mb-0">
          <p className="px-0.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-tertiary">{cat.name}</p>
          <div className="grid grid-cols-8 gap-0.5">
            {cat.emoji.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => onPick(e)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-lg transition-transform hover:scale-110 hover:bg-black/[0.06] dark:hover:bg-white/10"
                aria-label={`Insert ${e}`}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
