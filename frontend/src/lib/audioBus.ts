// SHARD — global audio. Two jobs that share one idea: the tab should never
// make two sounds at once, and it should never fetch an audio file to do it.
//
// 1. Chat media (voice notes, audio attachments, video files) live in
//    independent <audio>/<video> elements; claimAudio() enforces the
//    messenger rule that only ONE of them plays at a time.
// 2. The UI sounds (sent, received, ringing) are SYNTHESISED on an
//    AudioContext. Three short tones cost ~0 kB of bundle and no request at
//    all, where shipping mp3s would mean bytes the privacy-conscious bundle
//    otherwise never downloads — and a room that has not spoken yet should
//    not have paid for its notification sounds.

let current: HTMLMediaElement | null = null;

/** Call from an element's `onPlay`: pauses the previous sound, if any. */
export function claimAudio(el: HTMLMediaElement) {
  if (current && current !== el && !current.paused) {
    current.pause();
  }
  current = el;
}

// --------------------------------------------------------------- mute store
// Mirrors lib/themeStore.ts: a module-level flag plus a listener set, so the
// header toggle and every play() call read one truth without prop drilling.

const SOUND_KEY = "shard-sound";
const soundListeners = new Set<() => void>();

function readStoredSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    // Private mode / storage blocked: stay audible rather than silently mute.
    return true;
  }
}

// Default is ON: a messenger that stays quiet with no explanation is worse
// than one that makes a small noise the user can switch off once.
let soundEnabled = readStoredSound();

export function isSoundEnabled(): boolean {
  return soundEnabled;
}

export function setSoundEnabled(on: boolean, persist = true) {
  soundEnabled = on;
  if (!on) stopCallTone(); // never leave a ring running behind a mute
  if (persist) {
    try {
      localStorage.setItem(SOUND_KEY, on ? "on" : "off");
    } catch {
      // Ignore storage failures (private mode): the toggle still applies live.
    }
  }
  soundListeners.forEach((l) => l());
}

export function toggleSound(): void {
  setSoundEnabled(!soundEnabled);
}

export function subscribeSound(listener: () => void): () => void {
  soundListeners.add(listener);
  return () => soundListeners.delete(listener);
}

// Reconcile when another tab flips the preference.
window.addEventListener("storage", (e) => {
  if (e.key === SOUND_KEY) {
    soundEnabled = readStoredSound();
    soundListeners.forEach((l) => l());
  }
});

// ---------------------------------------------------------------- synthesis

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

/** Master level. Deliberately low: these sit under a conversation. */
const MASTER_GAIN = 0.13;

/**
 * Lazily builds the AudioContext and returns it, or null when the browser has
 * no Web Audio (old Safari) — every caller treats null as "play nothing"
 * rather than throwing, so a missing FX layer never breaks the room.
 */
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);
    // Autoplay policy: the context starts suspended until a real gesture.
    // Sending a message is one, so the first outgoing tap unlocks it; a
    // one-shot listener also covers the case where the first sound we ever
    // want is an INCOMING message.
    const unlock = () => {
      void ctx?.resume().catch(() => {});
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

interface ToneOptions {
  from: number;
  to?: number;
  /** Seconds from now. Lets one call lay out a chord without setTimeouts. */
  at?: number;
  dur: number;
  /** Peak amplitude of this tone, before the master gain. */
  gain: number;
  type?: OscillatorType;
}

/**
 * One enveloped oscillator. The exponential ramps never target 0 (illegal for
 * exponential ramps and audible as a click), so silence is 0.0001.
 */
function tone(c: AudioContext, opts: ToneOptions) {
  if (!master) return;
  const t0 = c.currentTime + (opts.at ?? 0);
  const dur = opts.dur;
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(opts.from, t0);
  if (opts.to !== undefined && opts.to !== opts.from) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), t0 + dur);
  }
  // Fast attack (8 ms) so the onset is crisp, then a full decay to silence.
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(opts.gain, t0 + Math.min(0.008, dur / 2));
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(env);
  env.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Outgoing: a soft downward click, 800 → 400 Hz over 90 ms. */
export function playSendSound() {
  if (!soundEnabled) return;
  const c = audio();
  if (!c) return;
  tone(c, { from: 800, to: 400, dur: 0.09, gain: 0.9 });
}

/** Incoming: a rising two-tone chime (E6 → A6), the universal "look here". */
export function playReceiveSound() {
  if (!soundEnabled) return;
  const c = audio();
  if (!c) return;
  tone(c, { from: 1318.5, dur: 0.085, gain: 0.55 });
  tone(c, { from: 1760, dur: 0.13, gain: 0.55, at: 0.085 });
}

// ------------------------------------------------------------- call ringing
// Cyclic, so it needs a stop as much as a start. The interval re-checks the
// preference every beat, which is what makes muting mid-ring take effect
// immediately instead of at the end of the current cycle.

const RING_PERIOD_MS = 1800;
let ringTimer: number | null = null;

function ringOnce(c: AudioContext) {
  // Two gentle pulses, then a pause: reads as "ringing" without being urgent.
  for (let i = 0; i < 2; i++) {
    const at = i * 0.17;
    tone(c, { from: 880, dur: 0.13, gain: 0.5, at });
    tone(c, { from: 1320, dur: 0.13, gain: 0.32, at });
  }
}

/** Starts (or leaves running) the incoming-call ring. Idempotent. */
export function playCallTone() {
  if (!soundEnabled || ringTimer !== null) return;
  const c = audio();
  if (!c) return;
  ringOnce(c);
  ringTimer = window.setInterval(() => {
    if (!soundEnabled) {
      stopCallTone();
      return;
    }
    const live = audio();
    if (!live) {
      stopCallTone();
      return;
    }
    ringOnce(live);
  }, RING_PERIOD_MS);
}

/** Stops the ring. Safe to call when nothing is ringing. */
export function stopCallTone() {
  if (ringTimer !== null) {
    window.clearInterval(ringTimer);
    ringTimer = null;
  }
}