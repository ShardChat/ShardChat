// SHARD — media bubbles, Telegram-Desktop / Apple style: compact rounded
// cards, monochrome surfaces, pill timers, 36px play targets. Theme is
// driven by tokens (bg-surface / border-line / text-heading:), so every
// bubble follows the active light or dark theme automatically.
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Download,
  FileCode,
  FileSpreadsheet,
  FileText,
  Film,
  Maximize2,
  Music,
  Pause,
  Play,
  Presentation,
  X,
} from "lucide-react";
import { formatBytes } from "../../lib/fileSecurity";
import { claimAudio } from "../../lib/audioBus";
import { clamp01 } from "../../lib/utils";

export type FileCategory = "video" | "audio" | "code" | "doc" | "archive" | "pdf" | "sheet" | "slides";

/** Maps a file name/mime to its display category. */
export function categorize(name: string, mime: string): FileCategory {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (mime.startsWith("video/") || [".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(ext)) return "video";
  if (mime.startsWith("audio/") || [".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"].includes(ext)) return "audio";
  if ([".go", ".ts", ".tsx", ".js", ".jsx", ".py", ".json", ".yaml", ".yml", ".sql", ".rs", ".css", ".html"].includes(ext)) {
    return "code";
  }
  if ([".zip", ".gz", ".tar", ".7z", ".rar"].includes(ext)) return "archive";
  if (ext === ".pdf" || mime === "application/pdf") return "pdf";
  if ([".xlsx", ".xls", ".csv", ".ods"].includes(ext)) return "sheet";
  if ([".pptx", ".ppt", ".odp"].includes(ext)) return "slides";
  return "doc";
}

const CATEGORY_ICON: Record<FileCategory, typeof FileText> = {
  video: Film,
  audio: Music,
  code: FileCode,
  doc: FileText,
  archive: Archive,
  pdf: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
};

/** Monochrome tile: no per-category color washes — zinc only. */
const CATEGORY_LABEL: Record<FileCategory, string> = {
  video: "Video",
  audio: "Audio",
  code: "Code",
  doc: "File",
  archive: "Archive",
  pdf: "PDF",
  sheet: "Spreadsheet",
  slides: "Presentation",
};

/** Truncates the middle of long file names, keeping the extension visible. */
function truncateName(name: string, max = 26): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot);
  const base = dot === -1 ? name : name.slice(0, dot);
  return `${base.slice(0, max - ext.length - 3)}…${base.slice(-2)}${ext}`;
}

/** L-7: hard-caps the download attribute within the ~255-byte filename
 *  budget of common filesystems, preserving the extension. The full name
 *  stays visible in the title/aria attributes. */
function downloadSafeName(name: string, max = 80): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot);
  if (ext.length >= max) return name.slice(0, max);
  return name.slice(0, max - ext.length) + ext;
}

function fmtTime(s: number) {
  if (!Number.isFinite(s) || s <= 0) return "--:--";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** Pill clock/timestamp: translucent over media, matte inside cards. */
function TimePill({ children, overlay = false }: { children: React.ReactNode; overlay?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 font-mono text-[10px] leading-none ${
        overlay
          ? "bg-black/60 text-white/90 backdrop-blur-md"
          : "text-tertiary"
      }`}
    >
      {children}
    </span>
  );
}

/** Caption under the media inside the same card. */
function Caption({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words px-3 pb-0.5 pt-2 text-[13px] leading-5 text-heading">
      {text}
    </p>
  );
}

/** Round 36px play/pause button — the single accent of the media bubbles. */
function PlayBtn({ playing, onClick, label }: { playing: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={playing ? "Pause" : "Play"}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-zinc-100 transition-all duration-150 hover:bg-zinc-700 active:scale-90 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
    >
      {playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="ml-0.5 h-4 w-4" aria-hidden />}
      <span className="sr-only">{label}</span>
    </button>
  );
}

/** Shared meta line: "Video · 5.3 MB" style type·size label. */
function MetaLine({ children }: { children: React.ReactNode }) {
  return <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-tertiary">{children}</p>;
}

/** Right rail shared by every attachment bubble: download on top, send
 *  time pinned to the bottom — identical across video/audio/file cards. */
function MetaRail({ url, name, time }: { url: string; name: string; time: string }) {
  return (
    <div className="flex shrink-0 flex-col items-end gap-1.5 self-stretch">
      <DownloadBtn url={url} name={name} />
      <span className="mt-auto">
        <TimePill>{time}</TimePill>
      </span>
    </div>
  );
}

// ============================================================
// VIDEO - player embedded in the bubble: rounded overflow-hidden
// card, own minimal controls, translucent pill timer on top.
// fullscreen is a fixed overlay wrapping the SAME <video> element,
// so playback never restarts; the ? button / Esc / dblclick close it.
// ============================================================
function VideoCard({
  url,
  name,
  size,
  caption,
  time,
}: {
  url: string;
  name: string;
  size: number;
  caption?: string;
  time: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dur, setDur] = useState(0);
  const [cur, setCur] = useState(0);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      claimAudio(v);
      void v.play();
    } else {
      v.pause();
    }
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    v.currentTime = clamp01((e.clientX - rect.left) / rect.width) * v.duration;
  };

  const openFull = () => {
    setFull(true);
    // true OS fullscreen when the browser allows it; the fixed overlay
    // below covers the whole window either way (e.g. when the API is
    // locked), so the video is always "на весь экран".
    wrapRef.current?.requestFullscreen?.().catch(() => undefined);
  };

  const closeFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    setFull(false);
  };

  // Esc without native fullscreen - and native exits (Esc / F11) via the
  // fullscreenchange event — both collapse the overlay.
  useEffect(() => {
    if (!full) return;
    const onFsChange = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFull();
    };
    document.addEventListener("fullscreenchange", onFsChange);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      window.removeEventListener("keydown", onKey);
    };
  }, [full]);

  // unmounting mid-fullscreen (message deleted/burned) must not strand the
  // fullscreen session.
  useEffect(
    () => () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    },
    [],
  );

  return (
    <div className="max-w-sm overflow-hidden rounded-2xl border border-line bg-surface ring-1 ring-black/[0.06] dark:ring-white/[0.06]">
      {/* Placeholder keeps the bubble's height while the video is pinned
          to the fixed fullscreen overlay (it leaves the normal flow). */}
      <div style={{ height: full ? 256 : 0 }} aria-hidden />
      <div
        ref={wrapRef}
        style={full ? { paddingTop: "env(safe-area-inset-top)" } : undefined}
        className={
          full
            ? "fixed inset-0 z-[100] flex items-center justify-center bg-black"
            : "group relative bg-black"
        }
      >
        <video
          ref={videoRef}
          src={url}
          controls={false}
          playsInline
          preload="metadata"
          className={`w-full cursor-pointer object-contain ${full ? "h-full" : "max-h-64"}`}
          onClick={toggle}
          onDoubleClick={full ? closeFull : openFull}
          onPlay={(e) => {
            claimAudio(e.currentTarget);
            setPlaying(true);
          }}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setCur(v.currentTime);
            setProgress(v.duration > 0 ? v.currentTime / v.duration : 0);
          }}
          onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        />

        {/* Center play affordance while idle */}
        {!playing && (
          <button
            type="button"
            onClick={toggle}
            aria-label="Play"
            className="absolute inset-0 flex items-center justify-center"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white shadow-md backdrop-blur-md transition-transform hover:scale-105">
              <Play className="ml-0.5 h-5 w-5" aria-hidden />
            </span>
          </button>
        )}

        {/* Fullscreen entry (hover, inline) / working close (fullscreen) */}
        {full ? (
          <button
            type="button"
            onClick={closeFull}
            aria-label="Exit fullscreen"
            title="Close (Esc)"
            style={full ? { top: "max(0.75rem, env(safe-area-inset-top))" } : undefined}
            className="absolute right-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-md transition-all hover:bg-black/80 active:scale-90"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            onClick={openFull}
            aria-label="Fullscreen"
            title="Fullscreen"
            className="touch-visible absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white opacity-0 backdrop-blur-md transition-opacity hover:bg-black/75 group-hover:opacity-100"
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}

        {/* Bottom control bar: play · scrubber · pill timer */}
        <div
          style={full ? { paddingBottom: "max(1rem, env(safe-area-inset-bottom))" } : undefined}
          className={`absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent ${
            full ? "px-3 pb-4 pt-8" : "px-2.5 pb-2 pt-6"
          }`}
        >
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? "Pause" : "Play"}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
          >
            {playing ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="ml-0.5 h-3.5 w-3.5" aria-hidden />}
          </button>
          <div
            className="h-1 min-w-0 flex-1 cursor-pointer overflow-hidden rounded-full bg-white/25"
            onClick={seek}
            role="slider"
            aria-label="Seek"
            aria-valuenow={Math.round(progress * 100)}
          >
            <div className="h-full rounded-full bg-white" style={{ width: `${progress * 100}%` }} />
          </div>
          <TimePill overlay>
            {fmtTime(cur)} / {fmtTime(dur)}
          </TimePill>
        </div>
      </div>

      {/* Meta strip: type · size, download + time on the shared rail */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <MetaLine>
          {CATEGORY_LABEL.video} · {formatBytes(size)}
        </MetaLine>
        <MetaRail url={url} name={name} time={time} />
      </div>
      {caption && <Caption text={caption} />}
    </div>
  );
}

// ============================================================
// AUDIO - compact horizontal player: 36px play, name on top,
// waveform track with progress, size·duration on the bottom line.
// ============================================================
function AudioCard({
  url,
  name,
  size,
  caption,
  time,
}: {
  url: string;
  name: string;
  size: number;
  caption?: string;
  time: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dur, setDur] = useState(0);

  // deterministic pseudo-waveform from the name: stable bars without
  // decoding the audio (the real peaks live only in voice notes).
  const bars = useRef<number[]>(
    (() => {
      let seed = 0;
      for (let i = 0; i < name.length; i++) seed = (seed * 31 + name.charCodeAt(i)) >>> 0;
      return Array.from({ length: 32 }, (_, i) => {
        seed = (seed * 1103515245 + 12345) >>> 0;
        return 0.25 + ((seed >>> 16) / 65535) * 0.75 * (0.6 + 0.4 * Math.sin(i / 3));
      }).map((v) => clamp01(v));
    })(),
  ).current;

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      claimAudio(a);
      void a.play();
    } else {
      a.pause();
    }
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !Number.isFinite(a.duration)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    a.currentTime = clamp01((e.clientX - rect.left) / rect.width) * a.duration;
  };

  return (
    <div className="max-w-sm rounded-2xl border border-line bg-surface p-3 ring-1 ring-black/[0.06] dark:ring-white/[0.06]">
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onPlay={(e) => {
          claimAudio(e.currentTarget);
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
        }}
        onTimeUpdate={(e) => {
          const a = e.currentTarget;
          setProgress(a.duration > 0 ? a.currentTime / a.duration : 0);
        }}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        className="hidden"
      />
      <div className="flex items-center gap-2.5">
        <PlayBtn playing={playing} onClick={toggle} label={name} />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-xs font-medium text-heading" title={name}>
            {truncateName(name)}
          </p>
          {/* Waveform: clickable track with listen progress */}
          <div
            className="mt-1.5 flex h-7 min-w-40 cursor-pointer items-center gap-[2px]"
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
                    filled ? "bg-zinc-800 dark:bg-zinc-100" : "bg-zinc-300 dark:bg-zinc-600/70"
                  }`}
                  style={{ height: `${Math.max(18, v * 100)}%` }}
                />
              );
            })}
          </div>
          <p className="mt-1 font-mono text-[11px] text-tertiary">
            {formatBytes(size)} · {fmtTime(dur)}
          </p>
        </div>
        <MetaRail url={url} name={name} time={time} />
      </div>
      {caption && <Caption text={caption} />}
    </div>
  );
}

// ============================================================
// FILE / DOC - monochrome tile card: icon square, name, type/size,
// Download + send time on the shared right rail (same as audio/video).
// ============================================================
function DownloadBtn({ url, name }: { url: string; name: string }) {
  return (
    <a
      href={url}
      download={downloadSafeName(name)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Download ${name}`}
      title={`Download ${name}`}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-secondary transition-all duration-150 hover:bg-black/[0.08] hover:text-heading active:scale-90 dark:text-zinc-300 dark:hover:bg-white/10 dark:hover:text-white"
    >
      <Download className="h-4 w-4" aria-hidden />
    </a>
  );
}

function DocCard({
  url,
  name,
  size,
  category,
  caption,
  time,
}: {
  url: string;
  name: string;
  size: number;
  category: FileCategory;
  caption?: string;
  time: string;
}) {
  const Icon = CATEGORY_ICON[category];
  return (
    <div className="max-w-sm rounded-2xl border border-line bg-surface ring-1 ring-black/[0.06] transition-colors duration-150 hover:border-line-strong dark:ring-white/[0.06]">
      <div className="flex items-center gap-3 p-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-black/[0.05] text-secondary dark:border-zinc-700/60 dark:bg-zinc-800/80 dark:text-zinc-300">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-medium text-heading" title={name}>
            {truncateName(name)}
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-tertiary">
            {formatBytes(size)} · {CATEGORY_LABEL[category]}
          </p>
        </div>
        <MetaRail url={url} name={name} time={time} />
      </div>
      {caption && <Caption text={caption} />}
    </div>
  );
}

/** Public entry: renders the right bubble for a generic attachment. */
export function FileMessageCard({
  url,
  name,
  mime,
  size,
  caption,
  time,
  mine,
}: {
  url: string;
  name: string;
  mime: string;
  size: number;
  caption?: string;
  time: string;
  mine: boolean;
  /** Kept for API compat: the bubbles now carry their own surfaces. */
  flush?: boolean;
}) {
  void mine;
  const category = categorize(name, mime);
  if (category === "video") {
    return <VideoCard url={url} name={name} size={size} caption={caption} time={time} />;
  }
  if (category === "audio") {
    return <AudioCard url={url} name={name} size={size} caption={caption} time={time} />;
  }
  return <DocCard url={url} name={name} size={size} category={category} caption={caption} time={time} />;
}
