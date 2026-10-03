// SHARD — voice recorder button: click to start/stop, live mic waveform
// while recording, escape hatch to cancel. Output feeds InputBar → sendAudio.
// neutral monochrome; the only red is the functional REC indication.
import { Mic, Square, Trash2 } from "lucide-react";
import { useVoiceRecord } from "../../hooks/useVoiceRecord";

// mirrors the dock's icon-button style from InputBar (single source of
// truth for both would be nicer, but a hook export would couple the files).
const iconBtn =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-tertiary transition-all duration-150 hover:bg-black/[0.06] hover:text-heading active:scale-90 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-strong dark:hover:bg-white/10";

interface VoiceRecorderProps {
  onSend: (result: { blob: Blob; wave: number[]; durationMs: number }) => void;
  /** True while the peer has not joined: recording stays off. */
  disabled?: boolean;
}

export function VoiceRecorder({ onSend, disabled = false }: VoiceRecorderProps) {
  // onLimit delivers the note the length cap finished on its own, so an
  // unattended recording is sent exactly like a manual stop.
  const { state, liveWave, start, stop, cancel } = useVoiceRecord({ onLimit: onSend });
  const recording = state === "recording";

  return (
    <div className="flex items-center gap-2">
      {recording && (
        <>
          <div className="flex h-8 items-end gap-[2px]" aria-hidden>
            {liveWave.slice(-16).map((v, i) => (
              <span key={i} className="w-[3px] rounded-full bg-zinc-500" style={{ height: `${Math.max(12, v * 100)}%` }} />
            ))}
          </div>
          <span className="flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> REC
          </span>
          <button
            type="button"
            onClick={() => cancel()}
            aria-label="Cancel recording"
            className="rounded-full p-2 text-tertiary transition-all duration-150 hover:bg-black/[0.06] hover:text-heading active:scale-90 dark:hover:bg-white/10"
          >
            <Trash2 className="h-5 w-5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => stop().then((r) => r && onSend(r))}
            aria-label="Stop and send"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-black text-white shadow-card transition-all duration-150 hover:bg-zinc-800 active:scale-90 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            <Square className="h-4 w-4" aria-hidden />
          </button>
        </>
      )}
      {!recording && (
        <button
          type="button"
          onClick={() => void start()}
          disabled={disabled || state === "processing"}
          aria-label="Record a voice message"
          title={disabled ? "Recording unlocks when your peer joins" : "Record a voice message"}
          className={iconBtn}
        >
          <Mic className="h-5 w-5" aria-hidden />
        </button>
      )}
    </div>
  );
}
