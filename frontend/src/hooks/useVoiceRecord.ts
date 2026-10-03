// SHARD — voice recording hook (MediaRecorder + AnalyserNode).
// Produces a webm/opus blob plus 28 normalized waveform peaks. All audio
// stays local until the caller encrypts it via cipher.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import { clamp01 } from "../lib/utils";

const WAVE_BARS = 28;

/** Hard cap on a single voice note (10 minutes). A voice note is sent as one
 *  sealed envelope rather than in chunks, so its size has to stay under the
 *  relay's 10 MB frame ceiling: past that the socket is torn down and the note
 *  never arrives. See RECORDER_BITRATE for the measured numbers. */
const MAX_RECORDING_MS = 10 * 60 * 1000;

/** Speech-grade Opus ceiling (measured ~49 kbps in Chrome, mono). A ten-minute
 *  note then seals to ~4.9 MB of base64 — half the frame limit. The browser
 *  default is ~125 kbps, which would produce ~12.6 MB and break delivery. */
const RECORDER_BITRATE = 48_000;

export interface RecordingResult {
  blob: Blob;
  wave: number[];
  durationMs: number;
}

type State = "idle" | "recording" | "processing";

// poll the whole recording up into a fixed bar count: the live meter only
// keeps a short rolling window, so sending that as the note's waveform would
// draw the final half second instead of the recording.
function toWave(peaks: number[]): number[] {
  if (peaks.length === 0) return [];
  const out: number[] = [];
  const step = peaks.length / WAVE_BARS;
  for (let i = 0; i < WAVE_BARS; i++) {
    const from = Math.floor(i * step);
    const to = Math.min(peaks.length, Math.max(from + 1, Math.floor((i + 1) * step)));
    let max = 0;
    for (let j = from; j < to; j++) max = Math.max(max, peaks[j]!);
    out.push(max);
  }
  return out;
}

interface UseVoiceRecordResult {
  state: State;
  /** Live waveform (normalized) while recording, for the mic-level UI. */
  liveWave: number[];
  start: () => Promise<void>;
  stop: () => Promise<RecordingResult | null>;
  cancel: () => void;
}

interface UseVoiceRecordOptions {
  /** Called with the finished note when the length cap stops the recording,
   *  so the auto-stop is delivered exactly like a manual stop-and-send. */
  onLimit?: (result: RecordingResult) => void;
}

export function useVoiceRecord({ onLimit }: UseVoiceRecordOptions = {}): UseVoiceRecordResult {
  const [state, setState] = useState<State>("idle");
  const [liveWave, setLiveWave] = useState<number[]>([]);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);
  const limitTimerRef = useRef<number>(0);
  const peaksRef = useRef<number[]>([]);
  const allPeaksRef = useRef<number[]>([]);
  const startedAtRef = useRef(0);
  const onLimitRef = useRef(onLimit);
  const stopRef = useRef<() => Promise<RecordingResult | null>>(async () => null);
  onLimitRef.current = onLimit;

  const cleanup = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    window.clearTimeout(limitTimerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    recorderRef.current = null;
    setLiveWave([]);
  }, []);

  const start = useCallback(async () => {
    if (state !== "idle") return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    const ctx = new AudioContext();
    ctxRef.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);

    const buf = new Uint8Array(analyser.frequencyBinCount);
    peaksRef.current = [];
    allPeaksRef.current = [];
    startedAtRef.current = Date.now();

    const sample = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]! - 128) / 128);
      const level = clamp01(peak * 1.6);
      allPeaksRef.current.push(level);
      peaksRef.current = [...peaksRef.current.slice(-(WAVE_BARS - 1)), level];
      setLiveWave(peaksRef.current);
      rafRef.current = requestAnimationFrame(sample);
    };
    rafRef.current = requestAnimationFrame(sample);

    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    // Explicit bitrate: without it the browser picks ~125 kbps, and a
    // ten-minute note would then seal to ~12.6 MB of base64 — past the relay's
    // 10 MB frame ceiling, where the socket dies and the note is lost. At
    // 48 kbps a full-length note is ~4.9 MB, still speech-transparent.
    const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: RECORDER_BITRATE });
    chunksRef.current = [];
    rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
    rec.start(100);
    recorderRef.current = rec;
    setState("recording");

    // Length cap: stop on its own at the limit and hand the finished note to
    // the caller, so an unattended recording ends the same way a manual stop
    // does instead of growing until the frame no longer fits.
    window.clearTimeout(limitTimerRef.current);
    limitTimerRef.current = window.setTimeout(() => {
      void stopRef.current().then((result) => {
        if (result) onLimitRef.current?.(result);
      });
    }, MAX_RECORDING_MS);
  }, [state]);

  const stop = useCallback(async (): Promise<RecordingResult | null> => {
    const rec = recorderRef.current;
    if (!rec || state !== "recording") return null;
    setState("processing");
    const durationMs = Date.now() - startedAtRef.current;

    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunksRef.current, { type: rec.mimeType }));
      rec.stop();
    });
    const wave = toWave(allPeaksRef.current);
    cleanup();
    setState("idle");
    return { blob, wave, durationMs };
  }, [state, cleanup]);

  // The length-cap timer has to reach stop() without depending on it, so it
  // goes through a ref instead of widening start()'s dependency list.
  stopRef.current = stop;

  const cancel = useCallback(() => {
    const rec = recorderRef.current;
    if (rec) {
      rec.onstop = () => {}; // drop the chunks
      rec.stop();
    }
    cleanup();
    setState("idle");
  }, [cleanup]);

  // If the room burns mid-recording the recorder unmounts without ever
  // calling stop() - release the mic track and AudioContext instead of
  // leaving the device hot until the tab dies.
  useEffect(() => {
    return () => {
      cancel();
    };
  }, [cancel]);

  return { state, liveWave, start, stop, cancel };
}
