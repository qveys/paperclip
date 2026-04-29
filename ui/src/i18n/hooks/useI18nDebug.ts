import { useCallback, useEffect, useState } from "react";
import {
  I18N_DEBUG_EVENT,
  I18N_DEBUG_STORAGE_KEY,
  readDebugFlag,
  writeDebugFlag,
} from "../debug-flag";

export interface UseI18nDebugResult {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  toggle: () => void;
}

export function useI18nDebug(): UseI18nDebugResult {
  const [enabled, setEnabledState] = useState<boolean>(() => readDebugFlag());

  const setEnabled = useCallback((value: boolean) => {
    writeDebugFlag(value);
    setEnabledState(value);
  }, []);

  const toggle = useCallback(() => {
    const next = !readDebugFlag();
    writeDebugFlag(next);
    setEnabledState(next);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onKeyDown = (e: KeyboardEvent) => {
      const isModifier = e.ctrlKey || e.metaKey;
      if (!isModifier || !e.shiftKey) return;
      if (e.key !== "L" && e.key !== "l") return;
      e.preventDefault();
      const next = !readDebugFlag();
      writeDebugFlag(next);
      setEnabledState(next);
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key !== I18N_DEBUG_STORAGE_KEY) return;
      setEnabledState(readDebugFlag());
    };

    // Same-tab toggles: writeDebugFlag dispatches this event so every
    // mounted hook (including useT) re-syncs without waiting on a reload
    // or another tab's storage event.
    const onDebugChanged = () => setEnabledState(readDebugFlag());

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("storage", onStorage);
    window.addEventListener(I18N_DEBUG_EVENT, onDebugChanged);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(I18N_DEBUG_EVENT, onDebugChanged);
    };
  }, []);

  return { enabled, setEnabled, toggle };
}

export default useI18nDebug;
