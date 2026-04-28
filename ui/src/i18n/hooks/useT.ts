import { createElement, useCallback, useEffect, useState, type ReactNode } from "react";
import type { TOptions } from "i18next";
import { useTranslation } from "react-i18next";

const DEBUG_KEY = "paperclip.i18n.debug";

export type I18nKeyState = "translated" | "fallback-en" | "missing";

export interface UseTResult {
  t: (key: string, options?: TOptions & { lng?: string }) => ReactNode;
  i18n: ReturnType<typeof useTranslation>["i18n"];
  ready: boolean;
}

function isDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

export function useT(ns?: string | string[]): UseTResult {
  const { t: rawT, i18n, ready } = useTranslation(ns);
  const [debugEnabled, setDebugEnabled] = useState<boolean>(() => isDebugEnabled());
  const nsKey = Array.isArray(ns) ? ns.join("|") : ns ?? "";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === DEBUG_KEY) {
        setDebugEnabled(isDebugEnabled());
      }
    };
    const onDebugToggle = () => setDebugEnabled(isDebugEnabled());
    window.addEventListener("storage", onStorage);
    window.addEventListener("paperclip:i18n-debug-changed", onDebugToggle as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("paperclip:i18n-debug-changed", onDebugToggle as EventListener);
    };
  }, []);

  const t = useCallback(
    (key: string, options?: TOptions & { lng?: string }): ReactNode => {
      const value = rawT(key, options) as unknown as string;
      if (!debugEnabled) return value;

      const overrideLng =
        options && typeof options === "object" && "lng" in options
          ? (options as { lng?: string }).lng
          : undefined;
      const lng = overrideLng ?? i18n.resolvedLanguage ?? i18n.language ?? "en";
      const existsOptions = ns ? { ns } : {};

      const inLng = i18n.exists(key, { ...existsOptions, lng, fallbackLng: false }) && value !== key;
      const inEn = inLng
        ? false
        : i18n.exists(key, {
            ...existsOptions,
            lng: "en",
            fallbackLng: false,
          }) && value !== key;
      const state: I18nKeyState = inLng ? "translated" : inEn ? "fallback-en" : "missing";

      return createElement(
        "span",
        {
          "data-i18n-key": key,
          "data-i18n-state": state,
          "data-i18n-lng": lng,
        },
        value
      );
    },
    [debugEnabled, i18n, ns, nsKey, rawT]
  );

  return { t, i18n, ready };
}

export default useT;
