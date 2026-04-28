import { useCallback, useEffect, useState } from "react";

const DEBUG_KEY = "paperclip.i18n.debug";
const ENABLED_VALUE = "1";

function readEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DEBUG_KEY) === ENABLED_VALUE;
  } catch {
    return false;
  }
}

function writeEnabled(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.localStorage.setItem(DEBUG_KEY, ENABLED_VALUE);
    } else {
      window.localStorage.removeItem(DEBUG_KEY);
    }
  } catch {
    /* ignore */
  }
}

export interface UseI18nDebugResult {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  toggle: () => void;
}

export function useI18nDebug(): UseI18nDebugResult {
  const [enabled, setEnabledState] = useState<boolean>(() => readEnabled());

  const setEnabled = useCallback((value: boolean) => {
    writeEnabled(value);
    setEnabledState(value);
  }, []);

  const toggle = useCallback(() => {
    setEnabledState((prev) => {
      const next = !prev;
      writeEnabled(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onKeyDown = (e: KeyboardEvent) => {
      const isModifier = e.ctrlKey || e.metaKey;
      if (!isModifier || !e.shiftKey) return;
      if (e.key !== "L" && e.key !== "l") return;
      e.preventDefault();
      setEnabledState((prev) => {
        const next = !prev;
        writeEnabled(next);
        return next;
      });
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key !== DEBUG_KEY) return;
      setEnabledState(e.newValue === ENABLED_VALUE);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return { enabled, setEnabled, toggle };
}

export default useI18nDebug;
