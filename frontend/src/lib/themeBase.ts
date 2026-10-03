// SHARD — theme bootstrap. Runs synchronously before React mounts to avoid
// a flash of the wrong theme: system preference by default, stored choice
// ('light' | 'dark') in localStorage['shard-theme'] wins when present.
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "shard-theme";

export function resolveInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
  // localStorage may be unavailable (private mode): fall through to system.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyThemeClass(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

// execute immediately on import - this module is loaded first in main.tsx.
applyThemeClass(resolveInitialTheme());
