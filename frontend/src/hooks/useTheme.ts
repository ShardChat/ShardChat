// SHARD — theme hook: useTheme() returns the current theme and a toggle
// that persists the user's explicit choice in localStorage['shard-theme'].
import { useCallback, useSyncExternalStore } from "react";
import { getTheme, setTheme, subscribe } from "../lib/themeStore";
import type { Theme } from "../lib/themeBase";

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const theme = useSyncExternalStore(subscribe, getTheme);
  const toggleTheme = useCallback(() => {
    setTheme(getTheme() === "dark" ? "light" : "dark", true);
  }, []);
  return { theme, toggleTheme };
}
