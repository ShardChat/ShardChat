import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Maximize,
  MessageSquare,
  Mic,
  MicOff,
  Monitor,
  MonitorUp,
  Phone,
  PhoneOff,
  Settings,
  SwitchCamera,
  Video,
  VideoOff,
} from "lucide-react";
import { SILENT_VIDEO_HEIGHT, SILENT_VIDEO_WIDTH, type MediaDeviceOption, type UseWebRTCCallResult } from "../../hooks/useWebRTCCall";
import { formatElapsed } from "../../lib/utils";

function bindStream(el: HTMLMediaElement | null, stream: MediaStream | null, mute = false) {
  if (!el) return;
  if (el.srcObject !== stream) el.srcObject = stream;
  el.muted = mute;
  if (!mute) el.volume = 1;
  void el.play().catch(() => {
    /* autoplay can wait for the next gesture */
  });
}

function playbackParts(stream: MediaStream | null) {
  if (!stream) return { video: null, audio: null };
  return {
    video: new MediaStream(stream.getVideoTracks()),
    audio: new MediaStream(stream.getAudioTracks()),
  };
}

/** True when the peer's video track is the near-black 499×371 canvas stub
 *  that stands in for "no camera" on the wire: it IS sent so the peer keeps
 *  receiving frames, but it must never be presented as if it were a picture.
 *  Decided from the track's actual frame size (not settings, which can lag).
 *  When detection is impossible (0×0), fail to "not presentable". */
function isSilentStub(t: MediaStreamTrack, el: HTMLVideoElement | null): boolean {
  if (el && el.videoWidth > 0 && el.videoHeight > 0) {
    return el.videoWidth === SILENT_VIDEO_WIDTH && el.videoHeight === SILENT_VIDEO_HEIGHT;
  }
  const { width = 0, height = 0 } = t.getSettings();
  if (width > 0 && height > 0) {
    return width === SILENT_VIDEO_WIDTH && height === SILENT_VIDEO_HEIGHT;
  }
  return false;
}

function isPresentableVideo(t: MediaStreamTrack, el: HTMLVideoElement | null = null): boolean {
  if (t.kind !== "video" || t.readyState !== "live" || t.muted) return false;
  if (isSilentStub(t, el)) return false;
  // decoded real frames beat possibly-empty getSettings() on remote tracks.
  if (el && el.videoWidth > 0 && el.videoHeight > 0) return true;
  const { width = 0, height = 0 } = t.getSettings();
  return width >= 80 || height >= 80;
}

async function applySink(el: HTMLMediaElement | null, sinkId: string) {
  if (!el || !sinkId || typeof el.setSinkId !== "function") return;
  try {
    await el.setSinkId(sinkId);
  } catch {
    /* device unplugged or unsupported */
  }
}

function DeviceSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: MediaDeviceOption[];
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  if (options.length === 0) {
    return (
      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-[11px] font-medium text-secondary">{label}</span>
        <span className="rounded-lg border border-line bg-sunken px-2.5 py-2 text-sm text-tertiary">
          No devices — allow access in the browser
        </span>
      </label>
    );
  }
  const known = options.some((o) => o.deviceId === value);
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium text-secondary">{label}</span>
      <select
        value={known ? value : ""}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="w-full truncate rounded-lg border border-line bg-sunken px-2.5 py-2 text-sm text-heading outline-none disabled:opacity-50"
      >
        <option value="">Default</option>
        {options.map((o) => (
          <option key={o.deviceId} value={o.deviceId}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function RoundBtn({
  label,
  onClick,
  tone = "idle",
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: "idle" | "off" | "end" | "on";
  children: ReactNode;
}) {
  const cls =
    tone === "end"
      ? "bg-red-600 text-white hover:bg-red-700"
      : tone === "off"
        ? "bg-red-600/10 text-red-600 ring-1 ring-red-600/20 hover:bg-red-600/15 dark:text-red-400"
        : tone === "on"
          ? "bg-black text-white dark:bg-white dark:text-black"
          : "card card-hover text-heading";
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors ${cls}`}
    >
      {children}
    </button>
  );
}

function useElapsed(startedAt: number | null, running: boolean) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!startedAt || !running) {
      setMs(0);
      return;
    }
    const tick = () => setMs(Date.now() - startedAt);
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAt, running]);
  return ms;
}

export function CallStage(props: UseWebRTCCallResult) {
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const elapsed = useElapsed(props.startedAt, props.phase === "active");
  const pip = props.minimized && (props.phase === "calling" || props.phase === "active");
  const remotePresentable =
    props.remoteStream?.getVideoTracks().some((t) => isPresentableVideo(t, remoteVideo.current)) ?? false;
  // Drive the stage purely by what the peer actually sends: the silent stub
  // (camera off) is never "presentable", so the placeholder persists after
  // camera on→off cycles instead of vanishing behind an invisible video.
  const showVideo = remotePresentable;
  // while THIS client shares the screen, the local screen feed is
  // ever rendered anywhere — re-filming the own capture is the infinity
  // mirror. A matte placeholder stands in for it instead.
  const showLocal =
    !props.isLocalScreenSharing &&
    Boolean(props.localStream) &&
    (props.sharing || (!props.cameraOff && (props.localStream?.getVideoTracks().some((t) => isPresentableVideo(t, localVideo.current)) ?? false)));
  // Пока ЭТОТ клиент шарит экран, на его стороне не рендерится НИ ОДНОГО
  // видео: ни свой захват (Bug 2 — бесконечное зеркало), ни камера пира —
  // она снимает монитор, на котором открыт этот же шаринг, и снова
  // рисует туннель. Только тёмная карточка «Вы делитесь экраном».
  const camOff = props.kind !== "video" || props.cameraOff;
  const status =
    props.phase === "calling" || !props.remoteStream
      ? "Connecting…"
      : `${formatElapsed(elapsed)}${props.sharing ? " · screen" : ""}`;

  useEffect(() => {
    const remote = playbackParts(props.remoteStream);
    bindStream(remoteVideo.current, remote.video, true);
    bindStream(remoteAudio.current, remote.audio, false);
    bindStream(localVideo.current, props.localStream, true);
    void applySink(remoteAudio.current, props.speakerId);
  }, [props.localStream, props.remoteStream, props.speakerId]);

  useEffect(() => {
    if (pip) setSettingsOpen(false);
  }, [pip]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!settingsRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [settingsOpen]);

  if (props.phase === "idle") return null;

  const unlockAudio = () => {
    void remoteAudio.current?.play().catch(() => undefined);
    void remoteVideo.current?.play().catch(() => undefined);
  };

  if (props.phase === "incoming") {
    return (
      <div className="page-bg safe-px fixed inset-0 z-50 flex flex-col items-center justify-center px-6">
        <span className="card flex h-20 w-20 items-center justify-center rounded-2xl">
          <Phone className="h-8 w-8 text-heading" aria-hidden />
        </span>
        <h2 className="mt-5 text-lg font-semibold text-heading">Incoming call</h2>
        <p className="mt-1 text-sm text-secondary">{props.kind === "video" ? "Video" : "Audio"} · P2P</p>
        <div className="mt-8 flex items-center gap-3">
          <button
            type="button"
            onClick={props.reject}
            className="card card-hover rounded-full px-5 py-2.5 text-sm font-medium text-secondary transition-colors hover:text-red-600 dark:hover:text-red-400"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => void props.accept()}
            className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 active:scale-[0.98] dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            Accept
          </button>
        </div>
      </div>
    );
  }

  const controls = (
    <div className={`flex flex-wrap items-center justify-center ${pip ? "gap-1.5" : "gap-2 max-sm:gap-x-2 max-sm:gap-y-2"}`}>
      <RoundBtn
        label={props.muted ? "Unmute microphone" : "Mute microphone"}
        onClick={props.toggleMute}
        tone={props.muted ? "off" : "idle"}
      >
        {props.muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
      </RoundBtn>
      <RoundBtn
        label={camOff ? "Turn camera on" : "Turn camera off"}
        onClick={() => void props.toggleCamera()}
        tone={camOff ? "off" : "idle"}
      >
        {camOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
      </RoundBtn>
      <RoundBtn
        label={props.sharing ? "Stop screen sharing" : "Share screen"}
        onClick={() => void props.toggleShare()}
        tone={props.sharing ? "on" : "idle"}
      >
        <MonitorUp className="h-5 w-5" />
      </RoundBtn>
      <RoundBtn
        label="Flip camera"
        onClick={() => void props.flipCamera()}
      >
        <SwitchCamera className={`h-5 w-5 ${props.canFlip ? "" : "opacity-40"}`} />
      </RoundBtn>
      <div className="relative" ref={settingsRef}>
        <RoundBtn label="Devices" onClick={() => setSettingsOpen((v) => !v)} tone={settingsOpen ? "on" : "idle"}>
          <Settings className="h-5 w-5" />
        </RoundBtn>
        {settingsOpen && (
          <div className="card absolute bottom-[calc(100%+12px)] left-1/2 z-[60] w-72 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-2xl p-3 shadow-pop">
            <p className="mb-2 text-xs font-medium text-heading">Devices</p>
            <div className="flex flex-col gap-2.5">
              <DeviceSelect label="Microphone" value={props.micId} options={props.audioInputs} onChange={props.setMic} />
              <DeviceSelect
                label="Camera"
                value={props.cameraId}
                options={props.videoInputs}
                disabled={props.sharing}
                onChange={props.setCameraDevice}
              />
              <DeviceSelect
                label="Speaker"
                value={props.speakerId}
                options={props.audioOutputs}
                onChange={props.setSpeaker}
              />
            </div>
          </div>
        )}
      </div>
      <RoundBtn label="End call" onClick={props.hangup} tone="end">
        <PhoneOff className="h-5 w-5" />
      </RoundBtn>
    </div>
  );

  return (
    <div
      className={
        pip
          ? // Minimized bubble: phone = compact portrait tile pinned UNDER the
            // header (keeps the input dock fully usable); desktop = the wide
            // bottom-right window with the full control row.
            "pointer-events-auto fixed right-3 top-[4.75rem] z-50 flex w-36 flex-col overflow-visible rounded-2xl sm:bottom-4 sm:right-4 sm:top-auto sm:w-[min(100vw-2rem,22rem)]"
          : "fixed inset-0 z-50 flex flex-col bg-zinc-950"
      }
      style={pip ? undefined : { paddingTop: "env(safe-area-inset-top)" }}
      onClick={unlockAudio}
    >
      <audio ref={remoteAudio} autoPlay className="pointer-events-none absolute h-px w-px opacity-0" />
      <div
        className={
          pip
            ? "card relative h-44 w-full shrink-0 overflow-hidden rounded-2xl bg-sunken shadow-pop sm:h-36 sm:rounded-t-2xl"
            : "relative min-h-0 flex-1 overflow-hidden bg-zinc-950"
        }
      >
        {/* Bug 2: hard containment — the video element fills its fixed flex
          * box (h-full + overflow-hidden); screens are letterboxed, never
          * cropped, and no capture can inflate the layout. */}
        <video
          ref={remoteVideo}
          className={`h-full w-full overflow-hidden ${
            showVideo ? "object-contain bg-zinc-950" : "opacity-0"
          }`}
          autoPlay
          playsInline
          muted
        />
        {!showVideo && (
          <div
            className={`absolute inset-0 flex flex-col items-center justify-center gap-3 ${
              pip ? "bg-sunken" : "bg-zinc-950"
            }`}
          >
            <span
              className={`flex items-center justify-center ${
                pip ? "card h-12 w-12 rounded-2xl" : "h-20 w-20 rounded-full bg-zinc-900 ring-1 ring-zinc-800"
              }`}
            >
              <Phone className={pip ? "h-5 w-5 text-heading" : "h-8 w-8 text-zinc-300"} />
            </span>
            {!pip && (
              <p className="text-sm font-medium text-zinc-300">
                {props.phase === "calling" ? "Calling…" : "Voice call"}
              </p>
            )}
          </div>
        )}
        {/* Пока идёт шаринг, сцена глухо-тёмная: только карточка «Вы делитесь
          * экраном». Ни свой захват, ни камера пира не рендерятся — иначе
          * получаем бесконечное зеркало-туннель (камера пира снимает монитор,
          * на котором открыт этот же шаринг). */}
        {props.isLocalScreenSharing && !pip && (
          <div
            role="status"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950"
          >
            <span className="flex h-20 w-20 items-center justify-center rounded-full bg-zinc-900 ring-1 ring-zinc-800">
              <Monitor className="h-8 w-8 text-zinc-300" aria-hidden />
            </span>
            <p className="text-sm font-medium text-zinc-300">You're sharing your screen</p>
          </div>
        )}
        {/* Local PiP: hidden while sharing (see above), hard-capped so it can
          * never inflate the layout. */}
        <video
          ref={localVideo}
          data-local
          className={`${
            pip
              ? "absolute bottom-2 right-2 h-11 w-16 rounded-md"
              : "absolute right-4 top-14 h-32 w-44 max-h-[60vh] rounded-xl"
          } object-contain shadow-pop ${pip ? "ring-1 ring-line" : "ring-1 ring-zinc-800"} ${
            props.sharing ? "" : "[transform:scaleX(-1)]"
          } ${
            showLocal ? "" : "hidden"
          }`}
          autoPlay
          muted
          playsInline
        />
        {pip && (
          <button
            type="button"
            className="absolute inset-0"
            onClick={() => props.setMinimized(false)}
            aria-label="Expand call"
          />
        )}
        {/* Minimized PiP: bring the call back. Shown on phones AND desktop —
            desktop had only the invisible tap-to-expand overlay, which gave no
            visible affordance at all. It sits INSIDE the bubble because the
            tile clips its overflow, and it brings the call back rather than
            hanging it up: the full row (mute/end) is one expand away. */}
        {pip && (
          <button
            type="button"
            onClick={() => props.setMinimized(false)}
            aria-label="Return to call"
            title="Return to call"
            className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-zinc-200 ring-1 ring-zinc-600/80 backdrop-blur-xl transition-colors hover:bg-zinc-800 active:scale-90 sm:right-3 sm:top-3 sm:h-9 sm:w-9"
          >
            <Maximize className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
          </button>
        )}
        <span
          className={`pointer-events-none absolute left-3 top-3 max-w-[calc(100%-3.5rem)] truncate rounded-full px-2.5 py-1 font-mono font-medium backdrop-blur-xl ${
            pip ? "bg-page/80 text-[10px] text-secondary" : "bg-black/50 text-[11px] text-zinc-300"
          }`}
        >
          {status}
        </span>
        {!pip && (
          <button
            type="button"
            title="Chat"
            aria-label="Open chat"
            onClick={() => props.setMinimized(true)}
            className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-zinc-300 ring-1 ring-zinc-800 backdrop-blur-xl transition-colors hover:bg-zinc-800"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
        )}
      </div>

      {pip ? (
        <div
          className="card line-t overflow-visible rounded-b-2xl bg-surface px-2 py-2 shadow-pop max-sm:hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {controls}
        </div>
      ) : (
        <div
          className="absolute inset-x-0 bottom-0 z-10 flex justify-center overflow-visible px-3 pb-7"
          style={{ paddingBottom: "max(1.75rem, calc(env(safe-area-inset-bottom) + 1.25rem))" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Phones portrait: the full 6-button row wraps into two centered
              lines inside the same card (6×44px + gaps > 390px width). */}
          <div className="card max-w-full overflow-visible rounded-2xl px-3 py-2.5 shadow-pop max-sm:mx-2 max-sm:py-2">
            {controls}
          </div>
        </div>
      )}
    </div>
  );
}
