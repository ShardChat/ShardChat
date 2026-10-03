// SHARD — on-screen keyboard awareness for phones. When the keyboard
// opens, the layout viewport may not shrink (iOS < 16.4 quirks, Android
// with interactive-widget=resizes-content unsupported), so this hook
// measures the VisualViewport and reports two things:
// inset — px of viewport currently covered by the keyboard
// active — true while any text field keeps the keyboard open
// the chat feeds `inset` into the input dock's bottom padding, so the
// composer always rides just above the keyboard — like mainstream
// messengers — instead of being covered by it.
import { useEffect, useState } from "react";

export function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return; // desktop: nothing to track

    let raf = 0;
    const update = () => {
      // keyboard height ≈ layout viewport bottom − visual viewport bottom.
      // scaled by zoom to stay in CSS pixels on pinch-zoomed pages.
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      const zoom = vv.scale || 1;
      setInset(Math.round(covered * zoom));

      // "Keyboard active" = the small viewport is meaningfully smaller than
      // the window AND something is focused (a resize alone can be a URL-bar
      // collapse). Tolerance absorbs smooth-keyboard animation frames.
      const kb = window.innerHeight - vv.height > 140;
      setActive(kb && document.activeElement !== document.body);
    };
    // rAF coalesces the resize storm, but rAF never fires while the tab is
    // hidden (OS keyboard transitions, backgrounded panes) — a short timeout
    // rides along as a safety net, and the first measurement runs directly.
    const schedule = () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      raf = requestAnimationFrame(update);
      timer = window.setTimeout(update, 120);
    };

    let timer = 0;
    update();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("focusin", schedule);
    window.addEventListener("focusout", schedule);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("focusin", schedule);
      window.removeEventListener("focusout", schedule);
    };
  }, []);

  return { keyboardInset: inset, keyboardActive: active };
}
