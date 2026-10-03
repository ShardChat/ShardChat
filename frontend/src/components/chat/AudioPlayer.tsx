// SHARD — voice note bubble, Telegram-Desktop style: 36px round play,
// waveform with listen progress, duration on the bottom line, send time
// On the shared right rail (same layout as file/audio/video cards).
// monochrome zinc, theme-driven via tokens — one look in both themes.
import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { clamp01 } from "../../lib/utils";
import { claimAudio } from "../../lib/audioBus";

interface AudioPlayerProps {
  audioBase64: string;
  wave: number[];
  /** Sender-side length: seeds the clock until the browser reports metadata. */
  durationMs?: number;
  mine: boolean;
}

function base64ToBlobUrl(b64: string, mime = "audio/webm"): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function fmtTime(s: number) {
  if (!Number.isFinite(s) || s <= 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function AudioPlayer({ audioBase64, wave, durationMs = 0, mine }: AudioPlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [dur, setDur] = useState(durationMs > 0 ? durationMs / 1000 : 0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // minted in the effect, not into a ref: a ref-assigned src would mount the
  // element empty and only reach the blob URL on some later re-render, and a
  // memoized URL would be handed out already revoked once StrictMode replays
  // the effect. Every pass mints its own URL, so src is never a dead one.
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!audioBase64) return;
    const next = base64ToBlobUrl(audioBase64);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [audioBase64]);

  // real recorded peaks when available; a calm synthetic fallback otherwise.
  const bars = useMemo(() => (wave.length ? wave : new Array(28).fill(0.35)), [wave]);

  // metadata wins once it arrives; until then the recorded length stands in.
  function totalOf(a: HTMLAudioElement) {
    return a.duration > 0 && Number.isFinite(a.duration) ? a.duration : dur;
  }

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const a = audioRef.current;
    if (!a) return;
    const el = e.currentTarget;
    const ratio = clamp01((e.clientX - el.getBoundingClientRect().left) / el.offsetWidth);
    const total = totalOf(a);
    if (total > 0) a.currentTime = ratio * total;
  }

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      claimAudio(a); // stop any other sound before this one starts
      setPlaying(true);
      void a.play().catch(() => setPlaying(false));
    } else {
      a.pause();
    }
  }

  return (
    <div
      className={`w-60 rounded-2xl border p-3 ${
        mine
          ? "border-line-strong bg-zinc-200/90 dark:bg-zinc-800/90"
          : "border-line bg-surface"
      }`}
    >
      <audio
        ref={audioRef}
        src={url || undefined}
        preload="metadata"
        onPlay={(e) => {
          claimAudio(e.currentTarget); // covers play from media session/keys too
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          const a = e.currentTarget;
          const total = totalOf(a);
          if (total <= 0) return;
          const real = a.duration > 0 && Number.isFinite(a.duration) ? a.duration : 0;
          if (real && Math.abs(real - dur) > 0.05) setDur(real);
          setProgress(clamp01(a.currentTime / total));
        }}
        onDurationChange={(e) => {
          const d = e.currentTarget.duration;
          if (d > 0 && Number.isFinite(d)) setDur(d);
        }}
        onEnded={(e) => {
          const a = e.currentTarget;
          // Recorder WebM carries no duration header, so the element can stop
          // parked at the end; rewind by hand or the next press is a no-op.
          try {
            a.currentTime = 0;
          } catch {
            /* not seekable yet — the clock still resets */
          }
          setPlaying(false);
          setProgress(0);
        }}
        onError={() => {
          setPlaying(false);
          setProgress(0);
        }}
        className="hidden"
      />
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-zinc-100 transition-all duration-150 hover:bg-zinc-700 active:scale-90 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          {playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="ml-0.5 h-4 w-4" aria-hidden />}
        </button>

        {/* Waveform: click-to-seek track with listen progress */}
        <div
          className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-[2px]"
          onClick={seek}
          role="slider"
          aria-label="Seek"
          aria-valuenow={Math.round(progress * 100)}
        >
          {bars.map((v, i) => {
            const filled = i / bars.length <= progress;
            return (
              <span
                key={i}
                className={`w-[3px] shrink-0 rounded-full transition-colors ${
                  filled
                    ? "bg-zinc-800 dark:bg-zinc-100"
                    : mine
                      ? "bg-zinc-400 dark:bg-zinc-600"
                      : "bg-zinc-300 dark:bg-zinc-600/70"
                }`}
                style={{ height: `${Math.max(18, clamp01(v) * 100)}%` }}
              />
            );
          })}
        </div>

        <span className="shrink-0 font-mono text-[10px] tabular-nums text-tertiary">
          {fmtTime(dur)}
        </span>
      </div>
    </div>
  );
}
