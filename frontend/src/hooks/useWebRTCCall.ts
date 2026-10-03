// SHARD — P2P audio/video on a native RTCPeerConnection. Signaling rides the
// existing room WebSocket (offer / answer / ICE), ICE uses Metered TURN from
// the Go API, and no third-party broker ever sees the session.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api } from "../lib/endpoints";
import type {
  CallIcePayload,
  CallInvitePayload,
  CallSignalPayload,
  IceServer,
  TurnCredentialsResponse,
  WSPacket,
  WSPacketType,
} from "../types/protocol";

export type CallKind = "audio" | "video";
export type CallPhase = "idle" | "calling" | "incoming" | "active";
export type FacingMode = "user" | "environment";

interface UseWebRTCCallOpts {
  enabled: boolean;
  dead: boolean;
  expiresAt: number | null;
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

async function fetchIceServers(): Promise<IceServer[]> {
  try {
    const res = await fetch(api("/api/turn-credentials"));
    if (!res.ok) throw new Error("turn");
    const data = (await res.json()) as TurnCredentialsResponse;
    if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      return data.iceServers;
    }
  } catch {
    /* fall through */
  }
  // No third-party TURN credentials and no Google STUN: STUN-only
  // keeps ICE peer-to-peer; operators can point VITE_STUN_URL at a
  // self-hosted STUN, or configure METERED_* server-side for a TURN relay.
  console.warn("[shard] TURN credentials unavailable — falling back to STUN-only ICE");
  return [{ urls: import.meta.env.VITE_STUN_URL ?? "stun:stun.cloudflare.com:3478" }];
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

/**
 * Builds the session's RTCPeerConnection and wires signaling to our own room
 * socket . Nothing leaves the two-peer channel any more: no PeerJS cloud,
 * no SDP on a third party's server.
 */
function createPeerConnection(
  send: (pkt: { type: WSPacketType; payload?: unknown }) => void,
  iceServers: RTCIceServer[],
): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
  pc.onicecandidate = (ev) => {
    // ev.candidate === null is the explicit end-of-candidates marker; the peer
    // needs it to finish gathering on browsers that trickle.
    send({ type: "CALL_ICE", payload: { candidate: ev.candidate ? ev.candidate.toJSON() : null } });
  };
  return pc;
}

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

/** Resolves the caller's offer, tolerating a hair of scheduling delay. */
async function waitForPendingOffer(
  ref: RefObject<CallSignalPayload | null>,
  timeoutMs = 2000,
): Promise<CallSignalPayload | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const offer = ref.current;
    if (offer) return offer;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => window.setTimeout(r, 40));
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

/** Calls negotiate a native RTCPeerConnection and the
 *  offer/answer/ICE travel over the session's own blind relay, so the public
 *  0.peerjs.com signaling cloud never sees a peer id, an SDP or a local IP. */
export function useWebRTCCall({
  enabled,
  dead,
  expiresAt,
  send,
  on,
}: UseWebRTCCallOpts): UseWebRTCCallResult {
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [kind, setKind] = useState<CallKind>("video");
  const [minimized, setMinimized] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [canFlip, setCanFlip] = useState(false);
  const [remotePeerReady, setRemotePeerReady] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceOption[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceOption[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceOption[]>([]);
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
  /** Offer received from the caller while the incoming UI waits for a tap. */
  const pendingOfferRef = useRef<CallSignalPayload | null>(null);
  /** Candidates that arrived before we had a connection to attach them to
   *  (the callee is still ringing). Replayed onto the new connection. */
  const earlyIceRef = useRef<RTCIceCandidateInit[]>([]);
  /** True for the side that placed the call. Only that side renegotiates, so
   *  the two peers can never glare (simultaneous offers) — with exactly two
   *  participants that is as much as perfect negotiation needs. */
  const isCallerRef = useRef(false);
  /** ICE servers resolved once per session and shared by both roles. */
  const iceServersRef = useRef<RTCIceServer[] | null>(null);
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

  /** Resolves ICE servers once per session (Go /api/turn-credentials, or the
   *  STUN-only fallback). Cached so caller and callee reuse the same list. */
  const resolveIceServers = useCallback(async (): Promise<RTCIceServer[]> => {
    if (iceServersRef.current) return iceServersRef.current;
    const servers: RTCIceServer[] = [];
    try {
      servers.push(...(await fetchIceServers()));
    } catch {
      /* fall through to the STUN-only list */
    }
    iceServersRef.current = servers;
    return servers;
  }, []);

  const teardownMedia = useCallback(() => {
    hangingUpRef.current = true;
    micTrackRef.current = null;
    restoringRef.current = false;
    stopStream(localRef.current);
    stopStream(screenRef.current);
    stopStream(remoteRef.current);
    localRef.current = null;
    screenRef.current = null;
    remoteRef.current = null;
    pendingOfferRef.current = null;
    earlyIceRef.current = [];
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
        pc = createPeerConnection(
          (pkt) => sendRef.current(pkt),
          await resolveIceServers(),
        );
        pcRef.current = pc;
        // Replay whatever trickled in before this connection existed.
        if (earlyIceRef.current.length) {
          pendingIce.set(pc, [...earlyIceRef.current]);
          earlyIceRef.current = [];
        }
        pc.onnegotiationneeded = () => {
          // Renegotiation is single-writer: only the caller offers, which keeps
          // which keeps the state machine single-writer.
          if (!isCallerRef.current || hangingUpRef.current) return;
          void (async () => {
            try {
              const offer = await pc!.createOffer();
              await pc!.setLocalDescription(offer);
              sendRef.current({
                type: "CALL_OFFER",
                payload: { sdp: pc!.localDescription?.sdp ?? offer.sdp ?? "" } satisfies CallSignalPayload,
              });
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
    [adoptRemote, hangupInternal, resolveIceServers],
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
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        // setLocalDescription gives us the SDP with the gathered candidates
        // already appended; onicecandidate trickles any late ones.
        sendRef.current({
          type: "CALL_OFFER",
          payload: { sdp: pc.localDescription?.sdp ?? offer.sdp ?? "" } satisfies CallSignalPayload,
        });
      } catch {
        hangupInternal(true);
      }
    },
    [attachCall, dead, enabled, hangupInternal, remotePeerReady],
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
        // INVITE and OFFER travel the same ordered socket, but the offer can
        // still be a tick behind the ring UI — wait briefly instead of
        // turning the tap into a silent no-op.
        const offer = await waitForPendingOffer(pendingOfferRef);
        if (!offer || hangingUpRef.current) {
          hangupInternal(true);
          return;
        }
        const stream = await getLocalMedia(nextKind, facingRef.current, {
          audioId: micIdRef.current,
          videoId: cameraIdRef.current,
        });
        if (hangingUpRef.current || pendingOfferRef.current !== offer) {
          stopStream(stream);
          return;
        }
        stopStream(localRef.current);
        localRef.current = stream;
        micTrackRef.current = stream.getAudioTracks()[0] ?? null;
        setLocalStream(stream);
        const pc = await attachCall(stream);
        await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
        await flushIce(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendRef.current({
          type: "CALL_ANSWER",
          payload: { sdp: pc.localDescription?.sdp ?? answer.sdp ?? "" } satisfies CallSignalPayload,
        });
        pendingOfferRef.current = null;
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
  }, [attachCall, hangupInternal]);

  const reject = useCallback(() => {
    sendRef.current({ type: "CALL_REJECT" });
    pendingOfferRef.current = null;
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

  // Session lifecycle hook. There is no broker any more, so this only
  // arms the ICE server list and tears the call down when the room dies.
  useEffect(() => {
    if (!enabled || dead) return;
    let cancelled = false;
    void (async () => {
      await resolveIceServers();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
      hangupInternal(false);
      setRemotePeerReady(false);
    };
  // resolveIceServers / hangupInternal are stable enough; recreate only on
  // room life.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, dead]);

  // WS signaling: presence, invite, offer/answer, ICE, reject, hangup.
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
        case "CALL_OFFER": {
          const sdp = (pkt.payload as CallSignalPayload | undefined)?.sdp;
          if (!sdp) return;
          // renegotiation (screen share on an audio-only call, a new track):
          // the caller re-offers mid-call and we answer straight away.
          if (phaseRef.current === "active" || phaseRef.current === "calling") {
            const pc = pcRef.current;
            if (!pc || isCallerRef.current) return;
            void (async () => {
              try {
                await pc.setRemoteDescription({ type: "offer", sdp });
                await flushIce(pc);
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                sendRef.current({
                  type: "CALL_ANSWER",
                  payload: { sdp: pc.localDescription?.sdp ?? answer.sdp ?? "" } satisfies CallSignalPayload,
                });
              } catch {
                /* keep the media that is already flowing */
              }
            })();
            return;
          }
          // first offer: INVITE always precedes it on the same socket, so the
          // incoming UI is up — hold the offer until Accept.
          pendingOfferRef.current = { sdp };
          setPhase("incoming");
          break;
        }
        case "CALL_ANSWER": {
          const sdp = (pkt.payload as CallSignalPayload | undefined)?.sdp;
          const pc = pcRef.current;
          if (!sdp || !pc) return;
          void pc
            .setRemoteDescription({ type: "answer", sdp })
            .then(() => flushIce(pc))
            .catch(() => {
              /* a stale answer (call already torn down) is not fatal */
            });
          break;
        }
        case "CALL_ICE": {
          const candidate = (pkt.payload as CallIcePayload | undefined)?.candidate ?? null;
          if (!candidate) return;
          const pc = pcRef.current;
          // No connection yet (still ringing): hold the candidates so the
          // connection we build on Accept inherits them.
          if (!pc) {
            earlyIceRef.current = [...earlyIceRef.current, candidate];
            return;
          }
          void applyIce(pc, candidate);
          break;
        }
        case "CALL_REJECT":
          if (phaseRef.current === "calling") hangupInternal(false);
          break;
        case "CALL_HANGUP":
          hangupInternal(false);
          break;
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
  }, [dead, enabled, hangupInternal, on]);

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
    canFlip,
    remotePeerReady,
    isLocalScreenSharing: sharing,
    localStream,
    remoteStream,
    startedAt,
    audioInputs,
    videoInputs,
    audioOutputs,
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
