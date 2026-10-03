// SHARD — global audio focus. Chat media (voice notes, audio attachments,
// video files) live in independent <audio>/<video> elements; this tiny bus
// enforces the messenger rule: only ONE sound plays at a time. Each media
// element claims focus on its `play` event, pausing whoever held it before.
// no registration/lifecycle needed - a single module-level reference.

let current: HTMLMediaElement | null = null;

/** Call from an element's `onPlay`: pauses the previous sound, if any. */
export function claimAudio(el: HTMLMediaElement) {
  if (current && current !== el && !current.paused) {
    current.pause();
  }
  current = el;
}
