// SHARD — theme store: tiny global state (no deps) mirroring the `dark`
// class on <html>. Components subscribe via useSyncExternalStore through
// the useTheme hook. Tracks the OS scheme live while the user has not
// made an explicit choice.
import type { Theme } from "./themeBase";
import { applyThemeClass, resolveInitialTheme } from "./themeBase";

type Listener = () => void;

const listeners = new Set<Listener>();
let current: Theme = document.documentElement.classList.contains("dark") ? "dark" : "light";

export function getTheme(): Theme {
  return current;
}

export function setTheme(theme: Theme, persist: boolean) {
  current = theme;
  applyThemeClass(theme);
  if (persist) {
    try {
      localStorage.setItem("shard-theme", theme);
    } catch {
    // Ignore storage failures (private mode): theme still applies live.
    }
  }
  listeners.forEach((l) => l());
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Follow the OS scheme live until the user makes an explicit choice.
const media = window.matchMedia("(prefers-color-scheme: dark)");
media.addEventListener("change", (e) => {
  let hasStored = false;
  try {
    hasStored = localStorage.getItem("shard-theme") != null;
  } catch {
  // treat as no stored preference.
  }
  if (!hasStored) setTheme(e.matches ? "dark" : "light", false);
});

// Reconcile in case another tab changed the stored theme.
window.addEventListener("storage", (e) => {
  if (e.key === "shard-theme") setTheme(resolveInitialTheme(), false);
});
