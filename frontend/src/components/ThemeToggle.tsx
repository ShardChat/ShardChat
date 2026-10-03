// SHARD — round theme toggle for the navbar: Sun in dark mode, Moon in
// light mode, gentle rotate/scale crossfade and scale press feedback.
import { Moon, Sun } from "lucide-react";
import { useTheme } from "../hooks/useTheme";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={`card card-hover relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-secondary transition-all duration-200 active:scale-90 hover:text-heading ${className}`}
    >
      {/* Sun shows in dark mode, Moon in light mode; rotate+scale crossfade. */}
      <Sun
        className={`absolute h-4 w-4 transition-all duration-300 ${
          isDark ? "rotate-0 scale-100 opacity-100" : "rotate-90 scale-0 opacity-0"
        }`}
        aria-hidden
      />
      <Moon
        className={`absolute h-4 w-4 transition-all duration-300 ${
          isDark ? "-rotate-90 scale-0 opacity-0" : "rotate-0 scale-100 opacity-100"
        }`}
        aria-hidden
      />
    </button>
  );
}
