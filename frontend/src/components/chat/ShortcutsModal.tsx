// SHARD — keyboard shortcuts reference. Opened with `?` from anywhere in the
// room that is not a text field. Escape (or the backdrop, or the close button)
// dismisses it; nothing here is a shortcut you can trigger, so no listener
// other than the dismiss keys is installed.
import { useEffect, useRef } from "react";
import { Keyboard, X } from "lucide-react";

interface ShortcutsModalProps {
  onClose: () => void;
}

/** Keys are shown with the platform's own modifier glyph: ⌘ on macOS, Ctrl elsewhere. */
const IS_APPLE =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["Enter"], label: "Send message" },
  { keys: ["Shift", "Enter"], label: "New line" },
  { keys: ["↑"], label: "Edit last message" },
  { keys: ["Esc"], label: "Cancel reply / close this" },
  { keys: [IS_APPLE ? "⌘" : "Ctrl", "V"], label: "Paste screenshot" },
  { keys: [IS_APPLE ? "⌘" : "Ctrl", "\\"], label: "Hide / show sessions" },
  { keys: ["?"], label: "Open this dialog" },
];

/** One key cap, or a ⌘/⇧-style glyph rendered slightly smaller and dimmer. */
function KeyCap({ label }: { label: string }) {
  const isGlyph = label.length === 1 && /[⌘⇧⌥⌃⏎]/.test(label);
  return (
    <kbd
      className={`inline-flex min-w-[1.75rem] items-center justify-center rounded-md border border-line bg-black/[0.04] px-1.5 py-1 font-mono text-[11px] font-medium text-secondary dark:bg-white/[0.06] dark:text-zinc-300 ${
        isGlyph ? "text-[13px]" : ""
      }`}
    >
      {label}
    </kbd>
  );
}

export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Escape closes, matching the dock's Escape rule (cancel reply / close).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Move focus into the dialog so the next Tab stays inside it and a screen
  // reader announces the reference instead of leaving the user on the message
  // list behind the backdrop.
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="card shadow-pop w-full max-w-sm rounded-2xl p-4 focus:outline-none"
      >
        <div className="mb-3 flex items-center gap-2">
          <Keyboard className="h-4 w-4 shrink-0 text-tertiary" aria-hidden />
          <h2 className="flex-1 text-sm font-semibold text-heading">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1 text-tertiary transition-colors hover:bg-black/[0.06] hover:text-heading dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <dl className="space-y-1.5">
          {SHORTCUTS.map(({ keys, label }) => (
            <div
              key={label}
              className="flex items-center justify-between gap-3 rounded-xl px-2 py-1.5 odd:bg-black/[0.02] dark:odd:bg-white/[0.03]"
            >
              <dt className="min-w-0 flex-1 truncate text-xs text-secondary">{label}</dt>
              <dd className="flex shrink-0 items-center gap-1">
                {keys.map((k) => (
                  <KeyCap key={k} label={k} />
                ))}
              </dd>
            </div>
          ))}
        </dl>

        <p className="mt-3 border-t border-line pt-2.5 text-[11px] leading-relaxed text-tertiary">
          Screenshots pasted from the clipboard are encrypted and queued like any other photo — drop one
          onto the chat, or press {IS_APPLE ? "⌘" : "Ctrl"} + V.
        </p>
      </div>
    </div>
  );
}