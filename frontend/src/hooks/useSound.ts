// SHARD — sound hook: useSound() returns whether UI sounds are on and a
// toggle that persists the choice in localStorage['shard-sound'].
// Same shape as useTheme, over the store in lib/audioBus.ts.
import { useCallback, useSyncExternalStore } from "react";
import { isSoundEnabled, subscribeSound, toggleSound } from "../lib/audioBus";

export function useSound(): { soundEnabled: boolean; toggleSound: () => void } {
  const soundEnabled = useSyncExternalStore(subscribeSound, isSoundEnabled, isSoundEnabled);
  const toggle = useCallback(() => {
    toggleSound();
  }, []);
  return { soundEnabled, toggleSound: toggle };
}