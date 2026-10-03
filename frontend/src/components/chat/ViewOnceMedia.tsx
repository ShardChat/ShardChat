// SHARD — view-once ("burn after viewing") media. The receiver sees a
// blurred tile; one click reveals the image and starts a 10-second burn
// countdown, after which the parent wipes the message from memory and DOM.
import { useEffect, useState } from "react";
import { Flame } from "lucide-react";

const BURN_AFTER_VIEW_MS = 10_000;

interface ViewOnceMediaProps {
  src: string;
  alt: string;
  /** Sender-side view: already burned locally, show the ghost tile. */
  burned?: boolean;
  onOpen: () => void;
  onBurn: () => void;
}

export function ViewOnceMedia({ src, alt, burned, onOpen, onBurn }: ViewOnceMediaProps) {
  const [revealed, setRevealed] = useState(false);
  const [msLeft, setMsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!revealed) return;
    const started = Date.now();
    const tick = () => {
      const left = BURN_AFTER_VIEW_MS - (Date.now() - started);
      if (left <= 0) {
        onBurn();
        return;
      }
      setMsLeft(left);
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed]);

  if (burned) {
    return (
      <div className="flex h-40 w-56 items-center justify-center rounded-lg border border-line bg-sunken">
        <span className="flex items-center gap-1.5 text-xs text-tertiary">
          <Flame className="h-4 w-4" aria-hidden />
          Viewed and destroyed
        </span>
      </div>
    );
  }

  if (!revealed) {
    return (
      <button
        type="button"
        onClick={() => {
          setRevealed(true);
          onOpen();
        }}
        className="group relative block h-40 w-56 overflow-hidden rounded-lg border border-line"
        aria-label="View the photo (burns after viewing)"
      >
        <img src={src} alt="" className="h-full w-full scale-110 object-cover blur-xl" aria-hidden />
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/30 text-white transition-colors group-hover:bg-black/40">
          <Flame className="h-5 w-5" aria-hidden />
          <span className="text-xs font-medium">Burn after viewing</span>
          <span className="text-[10px] opacity-80">Click to reveal · 10 sec</span>
        </span>
      </button>
    );
  }

  return (
    <div className="relative">
      <img src={src} alt={alt} className="max-h-64 rounded-lg object-cover" />
      {msLeft !== null && (
        <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 font-mono text-[10px] font-medium text-white backdrop-blur-sm">
          <Flame className="h-3 w-3" aria-hidden />
          {Math.ceil(msLeft / 1000)}s
        </span>
      )}
    </div>
  );
}
