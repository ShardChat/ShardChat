// SHARD — audio/video calls over a pluggable transport strategy.
//
//   p2p (default) — the two participants connect directly with one
//     RTCPeerConnection each; SDP/ICE ride the room relay socket as
//     CALL_OFFER / CALL_ANSWER / CALL_ICE packets (relayed blind, gated
//     behind KEY_EXCHANGE), and the ICE server list is fetched from the
//     relay's /api/webrtc-config with a hardwired STUN fallback. On hard
//     NATs and mobile networks WebRTC falls back to the TURN relay
//     automatically.
//   sfu — the media plane (SDP signaling + tracks) goes over a dedicated
//     socket to the standalone `shard-media` node (`mediaWsEndpoint`); the
//     SFU forwards RTP between the peers verbatim and never decodes it.
//
// Both modes share one PeerConnection pipeline (attachCall, renegotiation,
// screen share, camera flip), so every call feature behaves identically.
import { useCallback, useEffect, useRef, useState } from "react";
import { mediaWsEndpoint, webrtcConfigEndpoint } from "../lib/endpoints";
import type {
  CallAnswerPayload,
  CallIcePayload,
  CallInvitePayload,
  CallOfferPayload,
  WSPacket,
} from "../types/protocol";

export type CallKind = "audio" | "video";
export type CallPhase = "idle" | "calling" | "incoming" | "active";
export type FacingMode = "user" | "environment";

interface UseWebRTCCallOpts {
  enabled: boolean;
  dead: boolean;
  expiresAt: number | null;
  /** Room id, used to address the media node's signaling socket. */
  roomId: string;
  send: (pkt: WSPacket) => boolean;
  on: (handler: (pkt: WSPacket) => void) => () => void;
}

export interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

export interface UseWebRTCCallResult {
  phase: CallPhase;
  kind: CallKind;
  minimized: boolean;
  muted: boolean;
  cameraOff: boolean;
  sharing: boolean;
  /** False where the browser has no screen-capture API at all - which is
   *  every phone. The share control is not rendered there. */
  canShare: boolean;
  /** False when the device offers nothing to choose between. A phone has one
   *  microphone and one camera, so the picker is three dead dropdowns there
   *  and the control is not rendered. */
  canPickDevices: boolean;
  canFlip: boolean;
  remotePeerReady: boolean;
  /** THIS client is sharing its screen (vs. viewing the peer's share).
   *  UI must never render the local screen feed back into a large player. */
  isLocalScreenSharing: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  startedAt: number | null;
  audioInputs: MediaDeviceOption[];
  videoInputs: MediaDeviceOption[];
  audioOutputs: MediaDeviceOption[];
  micId: string;
  cameraId: string;
  speakerId: string;
  setMic: (deviceId: string) => void;
  setCameraDevice: (deviceId: string) => void;
  setSpeaker: (deviceId: string) => void;
  startCall: (kind: CallKind) => void;
  accept: () => void;
  reject: () => void;
  hangup: () => void;
  toggleMute: () => void;
  toggleCamera: () => void;
  toggleShare: () => void;
  flipCamera: () => void;
  setMinimized: (v: boolean) => void;
}

function stopStream(stream: MediaStream | null | undefined) {
  if (!stream) return;
  for (const t of stream.getTracks()) {
    t.onended = null;
    try {
      t.stop();
    } catch {
      /* already ended */
    }
  }
}

/** Call transport strategy, resolved once at module load: VITE_CALL_TRANSPORT
 *  wins; without it, a configured media node implies "sfu", otherwise the
 *  direct P2P path is the default. */
const transportMode: "p2p" | "sfu" =
  (import.meta.env.VITE_CALL_TRANSPORT as "p2p" | "sfu" | undefined) ??
  (import.meta.env.VITE_MEDIA_URL ? "sfu" : "p2p");

/** Last-resort ICE when /api/webrtc-config is unreachable: a single neutral
 *  STUN endpoint keeps direct peer paths alive; relayed (TURN) paths just
 *  degrade until the config endpoint answers. */
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

/** Fetches the relay's ICE/TURN configuration once per page load and caches
 *  it: credentials live on the backend (swappable from the Render dashboard,
 *  never hardcoded here), and the cached promise doubles as a request
 *  de-duplicator. Network failure degrades to the STUN-only fallback instead
 *  of killing the call path. */
let iceServersPromise: Promise<RTCIceServer[]> | null = null;
function loadIceServers(): Promise<RTCIceServer[]> {
  if (!iceServersPromise) {
    iceServersPromise = (async () => {
      try {
        const res = await fetch(webrtcConfigEndpoint());
        if (!res.ok) throw new Error(`webrtc-config ${res.status}`);
        const cfg = (await res.json()) as { iceServers?: RTCIceServer[] };
        if (Array.isArray(cfg.iceServers) && cfg.iceServers.length > 0) return cfg.iceServers;
        throw new Error("empty iceServers");
      } catch {
        return FALLBACK_ICE_SERVERS;
      }
    })();
  }
  return iceServersPromise;
}

/** Wire format of the shard-media signaling socket (sfu.SignalMsg): a thin
 *  envelope of offers / answers / trickled ICE candidates, both directions. */
type MediaSignal =
  | { type: "offer" | "answer"; sdp: { type: string; sdp: string } | null }
  | { type: "candidate"; candidate: RTCIceCandidateInit | null };

/** Wraps an SDP description into the SFU's offer/answer envelope. */
function mediaSdp(type: "offer" | "answer", sdp: string): MediaSignal {
  return { type, sdp: { type, sdp } };
}

/** One reusable "black screen" canvas keeps the video m-line alive without
 *  leaking a canvas + captureStream pair on every call . It stays
 *  referenced for the tab's lifetime by design — captureStream dies if the
 *  element is GC'd.
 *
 *  CRITICAL: a canvas painted ONCE emits no further frames, and WebRTC
 *  reacts to a frameless stream by FREEZING the last real frame the peer
 *  received (the frozen-screen-share bug). So the canvas is repainted every
 *  500 ms (near-black background + one imperceptible corner pixel) for as
 *  long as the tab lives: the encoder always has fresh pixels to send — the
 *  peer sees a stable near-black screen instead of a fossilized screenshot.
 *  The 499×371 size is a deliberate fingerprint: no real camera or display
 *  capture reports it, so CallStage can tell the stub apart from real video
 *  and show its placeholder instead of a black rectangle with a dot. */
export const SILENT_VIDEO_WIDTH = 499;
export const SILENT_VIDEO_HEIGHT = 371;

let silentCanvas: HTMLCanvasElement | null = null;

function makeSilentVideoTrack(): MediaStreamTrack {
  if (!silentCanvas) {
    silentCanvas = document.createElement("canvas");
    silentCanvas.width = SILENT_VIDEO_WIDTH;
    silentCanvas.height = SILENT_VIDEO_HEIGHT;
    const ctx = silentCanvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#09090b";
      ctx.fillRect(0, 0, silentCanvas.width, silentCanvas.height);
    }
    // frame pump: without periodic repaints captureStream emits nothing and
    // the remote player freezes on the previous track's final frame.
    window.setInterval(() => {
      const c = silentCanvas;
      if (!c) return;
      const g = c.getContext("2d");
      if (!g) return;
      g.fillStyle = "#09090b"; // matches the call-stage background
      g.fillRect(0, 0, c.width, c.height);
      // one 2×2 corner pixel flips every tick so the canvas truly changes —
      // invisible at any display size, but it keeps the frames flowing.
      g.fillStyle = Math.floor(Date.now() / 500) % 2 === 0 ? "#0b0b0e" : "#09090b";
      g.fillRect(2, 2, 2, 2);
    }, 500);
  }
  const stream = silentCanvas.captureStream(15);
  const track = stream.getVideoTracks()[0]!;
  track.enabled = true; // frames MUST flow; a disabled track suppresses them
  try {
    track.contentHint = "motion";
  } catch {
    /* Safari */
  }
  return track;
}

/** Screen-share replaceTrack needs a video m-line even on audio calls. */
function ensureVideoSenderTrack(stream: MediaStream): MediaStream {
  if (stream.getVideoTracks().length === 0) {
    stream.addTrack(makeSilentVideoTrack());
  }
  return stream;
}

function deviceLabel(kind: string, d: MediaDeviceInfo, i: number): string {
  if (d.label.trim()) return d.label;
  if (kind === "audioinput") return `Microphone ${i + 1}`;
  if (kind === "videoinput") return `Camera ${i + 1}`;
  return `Speaker ${i + 1}`;
}

/**
 * Builds the session's RTCPeerConnection. SDP/ICE signaling funnels through
 * `sendSignal`, which addresses whichever transport is active: the SFU's
 * socket in "sfu" mode, the room relay's CALL_* packets in "p2p" mode.
 */
function createPeerConnection(
  sendSignal: (msg: MediaSignal) => void,
  iceServers: RTCIceServer[],
): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers,
    bundlePolicy: "max-bundle",
  });
  pc.onicecandidate = (ev) => {
    // ev.candidate === null is the explicit end-of-candidates marker.
    sendSignal({ type: "candidate", candidate: ev.candidate ? ev.candidate.toJSON() : null });
  };
  return pc;
}

function senderFor(pc: RTCPeerConnection, kind: "audio" | "video"): RTCRtpSender | undefined {
  const byTrack = pc.getSenders().find((s) => s.track?.kind === kind);
  if (byTrack) return byTrack;
  const tr = pc.getTransceivers().find((t) => {
    const k = t.sender.track?.kind ?? t.receiver.track?.kind;
    return k === kind;
  });
  if (tr?.sender) return tr.sender;
  return pc.getSenders().find((s) => !s.track && kind === "video");
}

/** Remote ICE candidates that arrived before our remote description existed.
 *  addIceCandidate() rejects until then, so early ones wait here. */
const pendingIce = new WeakMap<RTCPeerConnection, RTCIceCandidateInit[]>();

/** Applies a trickled candidate, queueing it if the remote description has
 *  not landed yet (candidates routinely arrive first). */
async function applyIce(pc: RTCPeerConnection, candidate: RTCIceCandidateInit | null) {
  if (!candidate) return;
  if (!pc.remoteDescription) {
    pendingIce.set(pc, [...(pendingIce.get(pc) ?? []), candidate]);
    return;
  }
  try {
    await pc.addIceCandidate(candidate);
  } catch {
    /* a rejected candidate is not fatal: other pairs may still connect */
  }
}

async function flushIce(pc: RTCPeerConnection) {
  const queued = pendingIce.get(pc) ?? [];
  pendingIce.delete(pc);
  for (const c of queued) {
    try {
      await pc.addIceCandidate(c);
    } catch {
      /* see applyIce */
    }
  }
}

/** Camera capture targets: HD ideal with FullHD headroom and 30 fps. */
const CAMERA_VIDEO: MediaTrackConstraints = {
  width: { ideal: 1280, max: 1920 },
  height: { ideal: 720, max: 1080 },
  frameRate: { ideal: 30 },
};

/** Screen capture targets: FullHD ideal (4K headroom), 30 fps. */
const SCREEN_VIDEO: MediaTrackConstraints = {
  width: { ideal: 1920, max: 3840 },
  height: { ideal: 1080, max: 2160 },
  frameRate: { ideal: 30 },
};

/** Voice quality filters shared by every mic acquisition. */
const MIC_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

async function getLocalMedia(
  kind: CallKind,
  facing: FacingMode,
  ids?: { audioId?: string; videoId?: string },
): Promise<MediaStream> {
  const audio: MediaTrackConstraints = {
    ...MIC_AUDIO,
    ...(ids?.audioId ? { deviceId: { ideal: ids.audioId } } : {}),
  };
  const video: MediaTrackConstraints | boolean =
    kind === "video"
      ? ids?.videoId
        ? { deviceId: { ideal: ids.videoId }, ...CAMERA_VIDEO }
        : { facingMode: { ideal: facing }, ...CAMERA_VIDEO }
      : false;
  try {
    return ensureVideoSenderTrack(await navigator.mediaDevices.getUserMedia({ audio, video }));
  } catch (err) {
    if (kind === "video") {
      return ensureVideoSenderTrack(
        await navigator.mediaDevices.getUserMedia({ audio, video: false }),
      );
    }
    throw err;
  }
}

async function countVideoInputs(): Promise<number> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput").length;
  } catch {
    return 0;
  }
}

/** True when the local camera can plausibly be turned around.
 *
 *  A laptop reports two `videoinput` devices, so counting them is enough.
 *  A phone reports ONE device and exposes front/back as the `facingMode`
 *  capability of that single lens — counting alone always returns 1 there.
 *
 *  The capability probe cannot be trusted to rule it out either: several
 *  mobile engines omit `facingMode` from getCapabilities() entirely, so a
 *  purely capability-based check disables the button on exactly the handsets
 *  that need it. A touch-capable device is therefore treated as flippable and
 *  the attempt itself decides — flipCamera verifies the lens it got back. */
function canFlipCamera(track: MediaStreamTrack | null | undefined, deviceCount: number): boolean {
  if (deviceCount > 1) return true;
  const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { facingMode?: string[] };
  if (Array.isArray(caps.facingMode) && caps.facingMode.length > 1) return true;
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/** Calls negotiate against the shard-media SFU: ringing travels the room
 *  relay, SDP/ICE/tracks travel the media node's own socket. The SFU sees
 *  the media; the relay sees only that a call exists. */
export function useWebRTCCall({
  enabled,
  dead,
  expiresAt,
  roomId,
  send,
  on,
}: UseWebRTCCallOpts): UseWebRTCCallResult {
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [kind, setKind] = useState<CallKind>("video");
  const [minimized, setMinimized] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [sharing, setSharing] = useState(false);
  /** True once the browser turned out to have no screen-capture API at all
   *  (every phone). Drives the one-line explanation on the share control. */
  // Resolved once, before the first render: no mobile browser implements
  // getDisplayMedia (not Chrome for Android, not Safari for iOS), so the share
  // control is hidden there rather than left on screen looking broken.
  const [canShare] = useState(
    () => typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function",
  );
  const [canFlip, setCanFlip] = useState(false);
  const [remotePeerReady, setRemotePeerReady] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceOption[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceOption[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceOption[]>([]);
  // Nothing to switch between => nothing to offer. Counted from the live
  // device lists rather than from the UA, so a desktop with a single webcam
  // is spared the panel too while one with a headset keeps it.
  const canPickDevices = audioInputs.length > 1 || videoInputs.length > 1 || audioOutputs.length > 1;
  const [micId, setMicId] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [speakerId, setSpeakerId] = useState("");

  /** The live microphone track, kept aside so a screen-share audio swap
   *  (remote hears tab/screen sound) can hand it back on restore. */
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  /** Serializes screen-share restores: the UI button, the browser "Stop
   *  sharing" bar and a track "ended" event can all fire for one capture. */
  const restoringRef = useRef(false);
  /** The live call's peer connection: we own it, no broker. */
  const pcRef = useRef<RTCPeerConnection | null>(null);
  /** True for the side that placed the call. Only that side renegotiates, so
   *  the two peers can never glare (simultaneous offers) — with exactly two
   *  participants that is as much as perfect negotiation needs. */
  const isCallerRef = useRef(false);
  /** The media node's signaling socket for this room (one per call). */
  const mediaWsRef = useRef<WebSocket | null>(null);
  /** De-duplicates concurrent openMediaSocket() calls. */
  const mediaConnectRef = useRef<Promise<WebSocket> | null>(null);
  /** Serializes SDP processing of media-socket messages (answer vs. offer
   *  racing each other into the same PeerConnection). */
  const mediaMsgQueue = useRef<Promise<void>>(Promise.resolve());
  /** SDP offer that arrived before our PeerConnection existed (the user was
   *  still on the incoming-call screen); replayed by accept() once the
   *  tracks are attached. */
  const pendingRemoteOfferRef = useRef<string | null>(null);
  /** Outbound SDP/ICE sender, transport-aware (SFU socket or room relay). */
  const sendSignalRef = useRef<(msg: MediaSignal) => void>(() => {});
  const localRef = useRef<MediaStream | null>(null);
  /** Live remote media; re-exposed so mute/unmute edges can refresh it. */
  const remoteRef = useRef<MediaStream | null>(null);
  const screenRef = useRef<MediaStream | null>(null);
  const facingRef = useRef<FacingMode>("user");
  const kindRef = useRef<CallKind>("video");
  const phaseRef = useRef<CallPhase>("idle");
  const sendRef = useRef(send);
  const refreshDevicesRef = useRef<() => Promise<void>>(async () => {});
  const acceptingRef = useRef(false);
  const hangingUpRef = useRef(false);
  const micIdRef = useRef("");
  const cameraIdRef = useRef("");
  /** How many `videoinput` devices the UA reports right now. A single entry
   *  means a phone: the lens is chosen with facingMode, never with deviceId. */
  const videoInputCountRef = useRef(0);
  const speakerIdRef = useRef("");
  const mutedRef = useRef(false);
  const cameraOffRef = useRef(false);
  const sharingRef = useRef(false);
  sendRef.current = send;
  phaseRef.current = phase;
  kindRef.current = kind;
  mutedRef.current = muted;
  cameraOffRef.current = cameraOff;
  sharingRef.current = sharing;

  const teardownMedia = useCallback(() => {
    hangingUpRef.current = true;
    micTrackRef.current = null;
    restoringRef.current = false;
    // Media node socket: drop handlers first so its close event cannot
    // re-trigger a hangup, then close it. Every track and the PC follow.
    pendingRemoteOfferRef.current = null;
    const ws = mediaWsRef.current;
    mediaWsRef.current = null;
    mediaConnectRef.current = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    stopStream(localRef.current);
    stopStream(screenRef.current);
    stopStream(remoteRef.current);
    localRef.current = null;
    screenRef.current = null;
    remoteRef.current = null;
    isCallerRef.current = false;
    setLocalStream(null);
    setRemoteStream(null);
    setMuted(false);
    setCameraOff(false);
    setSharing(false);
    setStartedAt(null);
    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) {
      // Detach the ICE hook first: closing must not push a hangup packet.
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        /* already closed */
      }
    }
    window.setTimeout(() => {
      hangingUpRef.current = false;
    }, 0);
  }, []);

  const hangupInternal = useCallback(
    (notify: boolean) => {
      if (notify && phaseRef.current !== "idle") {
        sendRef.current({ type: "CALL_HANGUP" });
      }
      teardownMedia();
      setPhase("idle");
      setMinimized(false);
    },
    [teardownMedia],
  );

  const hangup = useCallback(() => hangupInternal(true), [hangupInternal]);

  /** Relay-side outbound: wraps the shared SDP envelope into the room
   *  socket's CALL_* packets. The relay forwards them blind between the two
   *  seats (gated behind KEY_EXCHANGE, like every app packet). */
  const sendRelaySignal = useCallback((msg: MediaSignal) => {
    if (msg.type === "offer") {
      sendRef.current({ type: "CALL_OFFER", payload: { sdp: msg.sdp?.sdp ?? "" } });
    } else if (msg.type === "answer") {
      sendRef.current({ type: "CALL_ANSWER", payload: { sdp: msg.sdp?.sdp ?? "" } });
    } else if (msg.type === "candidate") {
      sendRef.current({ type: "CALL_ICE", payload: { candidate: msg.candidate } });
    }
  }, []);

  /** Applies a remote offer and answers it. Shared by both transports: the
   *  callee in P2P mode (offer arrives as CALL_OFFER on the relay) and every
   *  SFU renegotiation offer alike. A mid-offer rollback keeps the SFU's
   *  glare rule (the remote's intent wins; its kick loop re-offers). */
  const processRemoteOffer = useCallback(async (sdp: string) => {
    const pc = pcRef.current;
    if (!pc) {
      // Our PeerConnection does not exist yet; accept() replays the offer
      // once the local tracks are attached.
      pendingRemoteOfferRef.current = sdp;
      return;
    }
    try {
      if (pc.signalingState === "have-local-offer") {
        await pc.setLocalDescription({ type: "rollback" });
      }
      await pc.setRemoteDescription({ type: "offer", sdp });
      await flushIce(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignalRef.current(mediaSdp("answer", pc.localDescription?.sdp ?? answer.sdp ?? ""));
    } catch (err) {
      // Without an answer the SFU drops this renegotiation after its
      // timeout; the tracks we lost re-arrive on the next offer.
      console.warn("[shard] remote offer not answered", err);
    }
  }, []);

  /** One signaling message from the active transport: the peer's answer, a
   *  remote offer, or a trickled ICE candidate. */
  const handleSignal = useCallback(
    async (msg: MediaSignal) => {
      const pc = pcRef.current;
      if (msg.type === "answer") {
        if (!pc || !msg.sdp) return;
        try {
          await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp.sdp });
          await flushIce(pc);
        } catch (err) {
          // a stale answer (call already torn down) is not fatal
          console.warn("[shard] media answer rejected", err);
        }
        return;
      }
      if (msg.type === "offer") {
        if (!msg.sdp) return;
        await processRemoteOffer(msg.sdp.sdp);
        return;
      }
      if (msg.type === "candidate" && msg.candidate) {
        if (!pc) return;
        void applyIce(pc, msg.candidate);
      }
    },
    [processRemoteOffer],
  );

  /**
   * Opens (or returns the already-open) media node socket for this room.
   * One socket per call; closed by teardownMedia. If it drops while a call
   * is live, the media plane is dead — notify the peer and hang up.
   */
  const openMediaSocket = useCallback((): Promise<WebSocket> => {
    const existing = mediaWsRef.current;
    if (existing && existing.readyState === WebSocket.OPEN) return Promise.resolve(existing);
    if (mediaConnectRef.current) return mediaConnectRef.current;
    mediaConnectRef.current = new Promise<WebSocket>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(mediaWsEndpoint(roomId));
      } catch (err) {
        mediaConnectRef.current = null;
        reject(err instanceof Error ? err : new Error("media socket"));
        return;
      }
      ws.onopen = () => {
        mediaConnectRef.current = null;
        mediaWsRef.current = ws;
        resolve(ws);
      };
      ws.onerror = () => {
        mediaConnectRef.current = null;
        reject(new Error("media socket failed"));
      };
      ws.onclose = () => {
        if (mediaWsRef.current === ws) mediaWsRef.current = null;
        mediaConnectRef.current = null;
        // Dead media socket is a dead call — unless teardown closed it.
        if (
          !hangingUpRef.current &&
          (phaseRef.current === "active" || phaseRef.current === "calling")
        ) {
          sendRef.current({ type: "CALL_HANGUP" });
          hangupInternal(false);
        }
      };
      ws.onmessage = (ev) => {
        // Serialize: an SFU answer and a renegotiation offer can arrive back
        // to back; applying the answer MUST complete before the offer is
        // processed, or its signaling-state check races and rolls back the
        // wrong direction.
        mediaMsgQueue.current = mediaMsgQueue.current
          .then(() => handleSignal(JSON.parse(String(ev.data)) as MediaSignal))
          .catch(() => {});
      };
    });
    return mediaConnectRef.current;
  }, [handleSignal, hangupInternal, roomId]);

  /** Sends one signaling envelope to the media node; silently ignored when
   *  the socket is gone (teardown owns cleanup in that case). */
  const sendMediaSignal = useCallback((msg: MediaSignal) => {
    const ws = mediaWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  /** The active outbound transport, refreshed on every render: the SFU's
   *  socket in "sfu" mode, the room relay's CALL_* packets in "p2p" mode. */
  sendSignalRef.current = transportMode === "sfu" ? sendMediaSignal : sendRelaySignal;

  const adoptRemote = useCallback((stream: MediaStream) => {
    remoteRef.current = stream;
    setRemoteStream(new MediaStream(stream.getTracks()));
    for (const t of stream.getTracks()) {
      t.onunmute = () => setRemoteStream(new MediaStream(stream.getTracks()));
      t.onmute = () => setRemoteStream(new MediaStream(stream.getTracks()));
      t.onended = () =>
        setRemoteStream(new MediaStream(stream.getTracks().filter((x) => x.readyState === "live")));
    }
  }, []);

  /** Creates (or reuses) the session's peer connection and attaches the remote
   *  track plumbing. Both roles funnel through here, so caller and callee can
   *  never end up with different handlers. */
  const attachCall = useCallback(
    async (stream: MediaStream): Promise<RTCPeerConnection> => {
      let pc = pcRef.current;
      if (!pc || pc.signalingState === "closed") {
        pc = createPeerConnection(sendSignalRef.current, await loadIceServers());
        pcRef.current = pc;
        pc.onnegotiationneeded = () => {
          // Renegotiation is single-writer: only the caller offers, which keeps
          // the state machine single-writer. (The SFU offers separately when
          // the other peer publishes; those offers are answered above.)
          if (!isCallerRef.current || hangingUpRef.current) return;
          void (async () => {
            try {
              const offer = await pc!.createOffer();
              await pc!.setLocalDescription(offer);
              sendSignalRef.current(mediaSdp("offer", pc!.localDescription?.sdp ?? offer.sdp ?? ""));
            } catch {
              /* a failed renegotiation leaves the current media flowing */
            }
          })();
        };
        pc.ontrack = (ev) => {
          const s =
            ev.streams[0] ??
            (() => {
              const cur = remoteRef.current ?? new MediaStream();
              if (!cur.getTracks().includes(ev.track)) cur.addTrack(ev.track);
              return cur;
            })();
          adoptRemote(s);
          if (phaseRef.current === "calling") {
            setPhase("active");
            setStartedAt((t) => t ?? Date.now());
          }
        };
        pc.onconnectionstatechange = () => {
          const state = pc?.connectionState;
          if (state !== "failed" && state !== "disconnected") return;
          if (hangingUpRef.current) return;
          // dead transport is a dead call: tell the peer instead of leaving
          // both sides on a frozen frame.
          sendRef.current({ type: "CALL_HANGUP" });
          hangupInternal(false);
        };
      }
      for (const track of stream.getTracks()) {
        if (!pc.getSenders().some((s) => s.track === track)) {
          pc.addTrack(track, stream);
        }
      }
      return pc;
    },
    [adoptRemote, hangupInternal],
  );

  const replaceTrackKind = useCallback(async (kind: "audio" | "video", track: MediaStreamTrack | null) => {
    const pc = pcRef.current;
    if (!pc) return false;
    const sender = senderFor(pc, kind);
    if (sender) {
      await sender.replaceTrack(track);
      return true;
    }
    if (track) {
      pc.addTrack(track, localRef.current ?? new MediaStream([track]));
      return true;
    }
    return false;
  }, []);

  const startCall = useCallback(
    async (nextKind: CallKind) => {
      if (!enabled || dead || !remotePeerReady) return;
      if (phaseRef.current !== "idle") return;
      setKind(nextKind);
      kindRef.current = nextKind;
      isCallerRef.current = true;
      setPhase("calling");
      setMinimized(false);
      try {
        const stream = await getLocalMedia(nextKind, facingRef.current, {
          audioId: micIdRef.current,
          videoId: cameraIdRef.current,
        });
        stopStream(localRef.current);
        localRef.current = stream;
        micTrackRef.current = stream.getAudioTracks()[0] ?? null;
        setLocalStream(stream);
        setCanFlip(nextKind === "video" && canFlipCamera(stream.getVideoTracks()[0], await countVideoInputs()));
        void refreshDevicesRef.current();
        sendRef.current({ type: "CALL_INVITE", payload: { kind: nextKind } satisfies CallInvitePayload });
        const pc = await attachCall(stream);
        if (transportMode === "sfu") {
          // Media plane: open the SFU socket and offer our tracks. The SFU
          // answers with everything already published in the room.
          const ws = await openMediaSocket();
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          // setLocalDescription gives us the SDP with the gathered candidates
          // already appended; onicecandidate trickles any late ones.
          if (ws.readyState !== WebSocket.OPEN) throw new Error("media socket closed");
          ws.send(JSON.stringify(mediaSdp("offer", pc.localDescription?.sdp ?? offer.sdp ?? "")));
        }
        // P2P: the tracks added above fire onnegotiationneeded, whose
        // single-writer handler (caller only) sends the CALL_OFFER through
        // the room relay; the callee answers with CALL_ANSWER.
      } catch {
        hangupInternal(true);
      }
    },
    [attachCall, dead, enabled, hangupInternal, openMediaSocket, remotePeerReady],
  );

  const accept = useCallback(() => {
    if (acceptingRef.current) return;
    if (phaseRef.current !== "incoming" && phaseRef.current !== "calling") return;
    const nextKind = kindRef.current;
    acceptingRef.current = true;
    isCallerRef.current = false;
    setMinimized(false);
    setPhase("calling");
    phaseRef.current = "calling";
    setStartedAt(Date.now());

    void (async () => {
      try {
        // The INVITE rang on the relay; media negotiation now happens with
        // the SFU: open its socket, offer our tracks, receive the caller's
        // tracks back inside the answer (plus any renegotiation offers for
        // tracks published after we joined).
        const stream = await getLocalMedia(nextKind, facingRef.current, {
          audioId: micIdRef.current,
          videoId: cameraIdRef.current,
        });
        if (hangingUpRef.current) {
          stopStream(stream);
          return;
        }
        stopStream(localRef.current);
        localRef.current = stream;
        micTrackRef.current = stream.getAudioTracks()[0] ?? null;
        setLocalStream(stream);
        const pc = await attachCall(stream);
        if (transportMode === "sfu") {
          const ws = await openMediaSocket();
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (ws.readyState !== WebSocket.OPEN) throw new Error("media socket closed");
          ws.send(JSON.stringify(mediaSdp("offer", pc.localDescription?.sdp ?? offer.sdp ?? "")));
        } else {
          // P2P: the caller's CALL_OFFER may have rung in before our tracks
          // were attached (we were still on the incoming screen) — answer it
          // now that the PeerConnection carries our media.
          const buffered = pendingRemoteOfferRef.current;
          pendingRemoteOfferRef.current = null;
          if (buffered) await processRemoteOffer(buffered);
        }
        setPhase("active");
        phaseRef.current = "active";
        const hasVideo = stream.getVideoTracks().some((t) => {
          const { width = 0, height = 0 } = t.getSettings();
          return t.readyState === "live" && (width >= 80 || height >= 80);
        });
        if (nextKind === "video" && !hasVideo) {
          setKind("audio");
          kindRef.current = "audio";
        }
        setCanFlip(hasVideo && canFlipCamera(stream.getVideoTracks()[0], await countVideoInputs()));
        void refreshDevicesRef.current();
      } catch {
        hangupInternal(true);
      } finally {
        window.setTimeout(() => {
          acceptingRef.current = false;
        }, 2500);
      }
    })();
  }, [attachCall, hangupInternal, processRemoteOffer]);

  const reject = useCallback(() => {
    sendRef.current({ type: "CALL_REJECT" });
    teardownMedia();
    setPhase("idle");
  }, [teardownMedia]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    localRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
  }, [muted]);

  const attachCameraTrack = useCallback(async () => {
    // With one reported camera (every phone) deviceId pins the ORIGINAL lens,
    // so a camera-off/on cycle would silently undo a flip. Drive by facingMode
    // there and keep the deviceId pin only for real multi-camera machines.
    const useDeviceId = videoInputCountRef.current > 1 && cameraIdRef.current;
    const cam = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: useDeviceId
        ? { deviceId: { ideal: cameraIdRef.current }, ...CAMERA_VIDEO }
        : { facingMode: { ideal: facingRef.current }, ...CAMERA_VIDEO },
    });
    const track = cam.getVideoTracks()[0];
    if (!track) {
      stopStream(cam);
      return false;
    }
    track.enabled = true;
    const ok = await replaceTrackKind("video", track);
    if (!ok) {
      track.stop();
      return false;
    }
    const old = localRef.current;
    const audio = old?.getAudioTracks() ?? [];
    old?.getVideoTracks().forEach((t) => {
      if (t !== track) {
        try {
          t.stop();
        } catch {
          /* already ended */
        }
      }
    });
    const mixed = new MediaStream([...audio, track]);
    localRef.current = mixed;
    setLocalStream(mixed);
    setKind("video");
    kindRef.current = "video";
    setCameraOff(false);
    setCanFlip(canFlipCamera(track, await countVideoInputs()));
    const id = track.getSettings().deviceId;
    if (id) {
      cameraIdRef.current = id;
      setCameraId(id);
    }
    return true;
  }, [replaceTrackKind]);

  const toggleCamera = useCallback(() => {
    if (sharingRef.current) return;
    const liveCam = localRef.current?.getVideoTracks().some((t) => {
      if (t.readyState !== "live") return false;
      const { width = 0, height = 0 } = t.getSettings();
      if (width === SILENT_VIDEO_WIDTH && height === SILENT_VIDEO_HEIGHT) return false; // the stub, not a camera
      return width >= 80 || height >= 80;
    });
    if (kindRef.current !== "video" || !liveCam) {
      void attachCameraTrack();
      return;
    }
    // camera OFF, Discord-style: the sender is swapped to the near-black
    // 499×371 stub so the peer can tell "camera off" (their UI shows the
    // placeholder) from "black picture", and the camera device is fully
    // released (the capture light goes off). The stub keeps frames flowing,
    // which also protects future replaceTrack calls from freezing.
    setCameraOff(true);
    void (async () => {
      const stub = makeSilentVideoTrack();
      const ok = await replaceTrackKind("video", stub);
      if (!ok) {
        // the swap failed — keep real frames flowing rather than going dark.
        setCameraOff(false);
        try {
          stub.stop();
        } catch {
          /* unused */
        }
        return;
      }
      const old = localRef.current;
      const audio = old?.getAudioTracks() ?? [];
      old?.getVideoTracks().forEach((t) => {
        if (t !== stub) {
          try {
            t.stop(); // release the camera hardware
          } catch {
            /* already ended */
          }
        }
      });
      const mixed = new MediaStream([...audio, stub]);
      localRef.current = mixed;
      setLocalStream(mixed);
    })();
  }, [attachCameraTrack, cameraOff, replaceTrackKind]);

  const restoreCameraAfterShare = useCallback(async () => {
    const display = screenRef.current;
    screenRef.current = null;
    setSharing(false); // isLocalScreenSharing → false: the chip yields to the camera
    if (!display) return; // idempotent: browser bar + UI button can both land here
    if (restoringRef.current) return; // a restore is already handling this capture
    restoringRef.current = true;
    try {
      if (phaseRef.current !== "active") {
        stopStream(display); // call is ending — teardownMedia owns the senders
        return;
      }
      const screenTrack = display.getVideoTracks()[0] ?? null;
      // live camera track still in our hands beats re-acquiring one.
      let video =
        localRef.current?.getVideoTracks().find((t) => t !== screenTrack && t.readyState === "live") ?? null;
      let acquired: MediaStream | null = null;
      if (!video) {
        try {
          const cam = await getLocalMedia(kindRef.current, facingRef.current, {
            audioId: micIdRef.current,
            videoId: cameraIdRef.current,
          });
          acquired = cam;
          video = kindRef.current === "video" ? (cam.getVideoTracks()[0] ?? null) : null;
        } catch {
          video = null; // camera busy/unavailable — the silent stub stands in
        }
      }
      // The fix: the video sender is swapped to a LIVE track (the camera, or
      // the silent-canvas stub when the camera is off/unavailable) and only
      // after a VERIFIED replaceTrack is the screen capture stopped. Stopping
      // first left the sender with a dead track → the peer's player froze on
      // the last frame forever.
      const target = video ?? makeSilentVideoTrack();
      let replaced = await replaceTrackKind("video", target);
      if (!replaced) {
        // one retry: the peer connection can still be settling.
        replaced = await replaceTrackKind("video", target);
      }
      if (!replaced) {
        // Keep the real (still live) screen running rather than freezing the
        // peer's frame; the user can retry the toggle or hang up.
        return;
      }
      if (screenTrack) {
        screenTrack.onended = null;
        try {
          screenTrack.stop();
        } catch {
          /* already ended */
        }
      }
      // audio: hand the parked mic back BEFORE releasing the captured sound.
      const parked = micTrackRef.current;
      const parkedLive = parked && parked.readyState === "live" ? parked : null;
      const camAudio = acquired?.getAudioTracks()[0] ?? null;
      const mic = parkedLive ?? (camAudio && camAudio.readyState === "live" ? camAudio : null);
      if (mic && mic !== parkedLive) micTrackRef.current = mic;
      if (mic) await replaceTrackKind("audio", mic);
      if (video) video.enabled = !cameraOff;
      // Snapshot BEFORE mutating the stream: removeTrack() would otherwise
      // hide the captured tab/screen audio from the cleanup pass below.
      const prevTracks = [...(localRef.current?.getTracks() ?? [])];
      // sync the LIVE MediaStream object itself — removeTrack the
      // screen capture (and captured tab sound), addTrack the camera/mic
      // back. Elements bound to this stream switch to the camera seamlessly;
      // fresh state reference forces CallStage to rebind srcObject too.
      const old = localRef.current;
      if (old) {
        for (const t of [...old.getTracks()]) {
          if (t !== mic && t !== video) old.removeTrack(t);
        }
        if (video && !old.getVideoTracks().includes(video)) old.addTrack(video);
        if (mic && !old.getAudioTracks().includes(mic)) old.addTrack(mic);
        localRef.current = old;
        setLocalStream(new MediaStream(old.getTracks()));
      } else {
        const mixed = new MediaStream([...(mic ? [mic] : []), ...(video ? [video] : [])]);
        localRef.current = mixed;
        setLocalStream(mixed);
      }
      // release the capture (screen video already stopped; also its audio)
      // and every spare track except the ones now in the mixed stream.
      stopStream(display);
      for (const t of [...prevTracks, ...(acquired?.getTracks() ?? [])]) {
        if (t !== mic && t !== video && t !== screenTrack) {
          try {
            t.stop();
          } catch {
            /* already ended */
          }
        }
      }
    } finally {
      restoringRef.current = false;
    }
  }, [cameraOff, replaceTrackKind]);

  const toggleShare = useCallback(async () => {
    if (phaseRef.current !== "active") return;
    if (sharing) {
      await restoreCameraAfterShare();
      return;
    }
    try {
      // Safety net only - the control is not rendered where the API is
      // missing, so this only guards a stale call path.
      if (!canShare) return;
      // FullHD ideal (4K headroom) at 30 fps. Chrome picker hints against
      // the infinity mirror: preselect the TAB surface (a tab capture can
      // never contain the viewer's own window - no recursive tunnel on
      // one-monitor setups) and hide our own call tab from the list so the
      // call can never accidentally capture itself.
      const shareVideo = {
        ...SCREEN_VIDEO,
        displaySurface: "browser",
        selfBrowserSurface: "exclude",
      } as MediaTrackConstraints;
      let display: MediaStream;
      try {
        display = await navigator.mediaDevices.getDisplayMedia({
          video: shareVideo,
          audio: true,
        });
      } catch {
        display = await navigator.mediaDevices.getDisplayMedia({
          video: shareVideo,
          audio: false,
        });
      }
      const screenTrack = display.getVideoTracks()[0];
      if (!screenTrack) {
        stopStream(display);
        return;
      }
      try {
        screenTrack.contentHint = "detail";
      } catch {
        /* Safari */
      }
      stopStream(screenRef.current);
      screenRef.current = display;
      const camTracks = [...(localRef.current?.getVideoTracks() ?? [])];
      const replaced = await replaceTrackKind("video", screenTrack);
      if (!replaced) {
        stopStream(display);
        screenRef.current = null;
        return;
      }
      // while sharing, the remote should hear the captured sound if there is
      // one; the live mic is parked (not stopped) and handed back on restore.
      const displayAudio = display.getAudioTracks()[0] ?? null;
      if (displayAudio) {
        const audioSwapped = await replaceTrackKind("audio", displayAudio);
        if (!audioSwapped) {
          try {
            displayAudio.stop();
          } catch {
            /* already ended */
          }
        }
      }
      const mic = displayAudio ? null : (localRef.current?.getAudioTracks()[0] ?? null);
      const mixed = new MediaStream([...(mic ? [mic] : []), ...(displayAudio ? [displayAudio] : []), screenTrack]);
      localRef.current = mixed;
      setLocalStream(mixed);
      setSharing(true);
      setCameraOff(false);
      camTracks.forEach((t) => {
        if (t !== screenTrack) {
          t.onended = null;
          try {
            t.stop();
          } catch {
            /* already ended */
          }
        }
      });
      screenTrack.onended = () => {
        void restoreCameraAfterShare();
      };
    } catch {
      /* user cancelled the picker */
    }
  }, [replaceTrackKind, restoreCameraAfterShare, sharing]);

  const flipCamera = useCallback(async () => {
    if (!canFlip || sharingRef.current || phaseRef.current !== "active" || kindRef.current !== "video") return;
    const prev = facingRef.current;
    const next: FacingMode = prev === "user" ? "environment" : "user";

    // ORDER MATTERS ON PHONES. A handset exposes one camera and refuses to
    // hand out a second stream while the first is still live — the request
    // fails with NotReadableError and the lens never moves, which is exactly
    // what "the button does nothing" looked like. Release the current track
    // FIRST, then acquire. Audio is captured before the swap so the call is
    // never interrupted; the peer sees a sub-second black frame instead.
    const audio = localRef.current?.getAudioTracks() ?? [];
    localRef.current?.getVideoTracks().forEach((t) => t.stop());

    const acquire = async (facing: FacingMode): Promise<MediaStream | null> => {
      // `exact` first, `ideal` as a fallback for engines that reject it.
      for (const video of [{ facingMode: { exact: facing } }, { facingMode: { ideal: facing } }]) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
          if (!stream.getVideoTracks()[0]) {
            stopStream(stream);
            continue;
          }
          // `ideal` is permitted to be IGNORED: some engines accept it and
          // hand back the very same lens, which would leave the user staring
          // at the same camera while facingRef claims otherwise. A stream
          // that is not the requested lens is worthless here — drop it and
          // try the next form.
          const actual = (stream.getVideoTracks()[0]!.getSettings?.() as
            | { facingMode?: string }
            | undefined)?.facingMode;
          if (actual && actual !== facing) {
            stopStream(stream);
            continue;
          }
          return stream;
        } catch {
          // refused this form, try the next one
        }
      }
      return null;
    };

    // Ask for the opposite lens; if the handset cannot deliver it, put the
    // one the user was watching back rather than leaving them with no camera.
    let got = next;
    let cam = await acquire(got);
    if (!cam) {
      got = prev;
      cam = await acquire(got);
    }
    facingRef.current = got;

    const newTrack = cam?.getVideoTracks()[0];
    if (!newTrack) {
      stopStream(cam);
      // Nothing could be acquired at all. Park the camera on the off stub so
      // the peer keeps a live stream rather than a frozen last frame.
      const stub = makeSilentVideoTrack();
      await replaceTrackKind("video", stub);
      const fallback = new MediaStream([...audio, stub]);
      localRef.current = fallback;
      setLocalStream(fallback);
      setCameraOff(true);
      return;
    }

    await replaceTrackKind("video", newTrack);
    const mixed = new MediaStream([...audio, newTrack]);
    localRef.current = mixed;
    setLocalStream(mixed);
    setCameraOff(false);
    const id = newTrack.getSettings().deviceId;
    if (id) {
      cameraIdRef.current = id;
      setCameraId(id);
    }
  }, [canFlip, replaceTrackKind]);

  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const pack = (kind: MediaDeviceKind, key: string) =>
        list
          .filter((d) => d.kind === kind && d.deviceId)
          .map((d, i) => ({ deviceId: d.deviceId, label: deviceLabel(key, d, i) }));
      setAudioInputs(pack("audioinput", "audioinput"));
      const videos = pack("videoinput", "videoinput");
      setVideoInputs(videos);
      videoInputCountRef.current = videos.length;
      setAudioOutputs(pack("audiooutput", "audiooutput"));
    } catch {
      /* permissions / insecure context */
    }
  }, []);
  refreshDevicesRef.current = refreshDevices;

  const setMic = useCallback(
    (deviceId: string) => {
      micIdRef.current = deviceId;
      setMicId(deviceId);
      if (phaseRef.current !== "active" && phaseRef.current !== "calling") return;
      void (async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            },
            video: false,
          });
          const track = stream.getAudioTracks()[0];
          if (!track) {
            stopStream(stream);
            return;
          }
          micTrackRef.current = track;
          track.enabled = !mutedRef.current;
          const ok = await replaceTrackKind("audio", track);
          if (!ok) {
            track.stop();
            return;
          }
          const old = localRef.current;
          const video = old?.getVideoTracks() ?? [];
          const mixed = new MediaStream([track, ...video]);
          localRef.current = mixed;
          setLocalStream(mixed);
          old?.getAudioTracks().forEach((t) => {
            if (t !== track) {
              try {
                t.stop();
              } catch {
                /* already ended */
              }
            }
          });
        } catch {
          /* keep previous mic */
        }
      })();
    },
    [replaceTrackKind],
  );

  const setCameraDevice = useCallback(
    (deviceId: string) => {
      cameraIdRef.current = deviceId;
      setCameraId(deviceId);
      if (sharingRef.current) return;
      if (phaseRef.current !== "active" && phaseRef.current !== "calling") return;
      void (async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: deviceId
              ? { deviceId: { exact: deviceId }, ...CAMERA_VIDEO }
              : { facingMode: { ideal: facingRef.current }, ...CAMERA_VIDEO },
          });
          const track = stream.getVideoTracks()[0];
          if (!track) {
            stopStream(stream);
            return;
          }
          track.enabled = !cameraOffRef.current;
          const ok = await replaceTrackKind("video", track);
          if (!ok) {
            track.stop();
            return;
          }
          const old = localRef.current;
          const audio = old?.getAudioTracks() ?? [];
          const mixed = new MediaStream([...audio, track]);
          localRef.current = mixed;
          setLocalStream(mixed);
          setKind("video");
          kindRef.current = "video";
          setCameraOff(false);
          track.enabled = true;
          old?.getVideoTracks().forEach((t) => {
            if (t !== track) {
              try {
                t.stop();
              } catch {
                /* already ended */
              }
            }
          });
        } catch {
          /* keep previous camera */
        }
      })();
    },
    [replaceTrackKind],
  );

  const setSpeaker = useCallback((deviceId: string) => {
    speakerIdRef.current = deviceId;
    setSpeakerId(deviceId);
  }, []);

  useEffect(() => {
    void refreshDevices();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const onChange = () => void refreshDevices();
    md.addEventListener("devicechange", onChange);
    return () => md.removeEventListener("devicechange", onChange);
  }, [refreshDevices]);

  // Session lifecycle hook: tears the call (tracks, PC, media socket) down
  // when the room dies or the hook unmounts.
  useEffect(() => {
    if (!enabled || dead) return;
    return () => {
      hangupInternal(false);
      setRemotePeerReady(false);
    };
  // hangupInternal is stable enough; recreate only on room life.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, dead]);

  // Relay WS signaling: presence, ringing, reject, hangup, burn — and, in
  // P2P mode, the SDP/ICE CALL_* packets (blind-relayed like every app
  // packet; in SFU mode the media node's socket owns them).
  useEffect(() => {
    if (!enabled || dead) return;
    const off = on((pkt) => {
      switch (pkt.type) {
        case "PEER_JOINED":
          // the room itself proves a second participant exists — no id
          // handshake with a third party needed any more.
          setRemotePeerReady(true);
          break;
        case "WELCOME": {
          const count = (pkt.payload as { peerCount?: number } | undefined)?.peerCount;
          if (typeof count === "number" && count >= 2) setRemotePeerReady(true);
          break;
        }
        case "KEY_EXCHANGE":
          // Strongest liveness signal we have: the peer holds our session key.
          setRemotePeerReady(true);
          break;
        case "PEER_LEFT":
          setRemotePeerReady(false);
          hangupInternal(false);
          break;
        case "CALL_INVITE": {
          const k = (pkt.payload as CallInvitePayload | undefined)?.kind;
          if (k === "audio" || k === "video") {
            kindRef.current = k;
            setKind(k);
            setPhase("incoming");
            setMinimized(false);
          }
          break;
        }
        case "CALL_REJECT":
          if (phaseRef.current === "calling") hangupInternal(false);
          break;
        case "CALL_HANGUP":
          hangupInternal(false);
          break;
        case "CALL_OFFER":
        case "CALL_ANSWER":
        case "CALL_ICE": {
          // P2P transport: SDP/ICE relayed blind over this socket. Same
          // serialized pipeline as SFU messages — an answer and a late
          // candidate must not race into the PeerConnection.
          const p = pkt.payload as Partial<CallOfferPayload & CallAnswerPayload & CallIcePayload> | undefined;
          let msg: MediaSignal | null = null;
          if (pkt.type === "CALL_ICE") {
            msg = { type: "candidate", candidate: p?.candidate ?? null };
          } else if (p?.sdp) {
            const t: "offer" | "answer" = pkt.type === "CALL_OFFER" ? "offer" : "answer";
            msg = { type: t, sdp: { type: t, sdp: p.sdp } };
          }
          if (msg) {
            mediaMsgQueue.current = mediaMsgQueue.current
              .then(() => handleSignal(msg as MediaSignal))
              .catch(() => {});
          }
          break;
        }
        case "ROOM_BURNED":
          hangupInternal(false);
          break;
        default:
          break;
      }
    });
    return () => {
      off();
    };
  }, [dead, enabled, handleSignal, hangupInternal, on]);

  // caller flips to active once remote media arrives.
  useEffect(() => {
    if (phase === "calling" && remoteStream) {
      setPhase("active");
      setStartedAt(Date.now());
    }
  }, [phase, remoteStream]);

  // TTL / burn: drop cameras immediately.
  useEffect(() => {
    if (dead) hangupInternal(false);
  }, [dead, hangupInternal]);

  useEffect(() => {
    if (!expiresAt || dead) return;
    const id = window.setInterval(() => {
      if (Date.now() >= expiresAt) hangupInternal(false);
    }, 1000);
    return () => window.clearInterval(id);
  }, [dead, expiresAt, hangupInternal]);

  useEffect(() => {
    const onHide = () => hangupInternal(false);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [hangupInternal]);

  return {
    phase,
    kind,
    minimized,
    muted,
    cameraOff,
    sharing,
    canShare,
    canFlip,
    remotePeerReady,
    isLocalScreenSharing: sharing,
    localStream,
    remoteStream,
    startedAt,
    audioInputs,
    videoInputs,
    audioOutputs,
    canPickDevices,
    micId,
    cameraId,
    speakerId,
    setMic,
    setCameraDevice,
    setSpeaker,
    startCall,
    accept,
    reject,
    hangup,
    toggleMute,
    toggleCamera,
    toggleShare,
    flipCamera,
    setMinimized,
  };
}
