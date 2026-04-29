import { createElement, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { TOptions } from "i18next";
import { useTranslation } from "react-i18next";
import { I18N_DEBUG_EVENT, I18N_DEBUG_STORAGE_KEY, readDebugFlag } from "../debug-flag";

export type I18nKeyState = "translated" | "fallback-en" | "missing";

export interface UseTResult {
  t: (key: string, options?: TOptions & { lng?: string }) => ReactNode;
  i18n: ReturnType<typeof useTranslation>["i18n"];
  ready: boolean;
}

export function useT(ns?: string | string[]): UseTResult {
  const { t: rawT, i18n, ready } = useTranslation(ns);
  const [debugEnabled, setDebugEnabled] = useState<boolean>(() => readDebugFlag());
  const nsKey = Array.isArray(ns) ? ns.join("|") : ns ?? "";
  // Stabilize the namespace reference across renders: callers passing inline
  // arrays (`useT(['core', 'common'])`) would otherwise re-create the t
  // callback on every render. nsKey collapses array identity to a stable key.
  const stableNs = useMemo(() => ns, [nsKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === I18N_DEBUG_STORAGE_KEY) {
        setDebugEnabled(readDebugFlag());
      }
    };
    const onDebugToggle = () => setDebugEnabled(readDebugFlag());
    window.addEventListener("storage", onStorage);
    window.addEventListener(I18N_DEBUG_EVENT, onDebugToggle as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(I18N_DEBUG_EVENT, onDebugToggle as EventListener);
    };
  }, []);

  const t = useCallback(
    (key: string, options?: TOptions & { lng?: string }): ReactNode => {
      const value = rawT(key, options) as unknown;
      // Only string values can be safely debug-wrapped in a <span>. Object
      // returns (e.g. when callers opt into `returnObjects`) pass through.
      if (!debugEnabled || typeof value !== "string") return value as ReactNode;

      const overrideLng =
        options && typeof options === "object" && "lng" in options
          ? (options as { lng?: string }).lng
          : undefined;
      const lng = overrideLng ?? i18n.resolvedLanguage ?? i18n.language ?? "en";
      const existsOptions = stableNs ? { ns: stableNs } : {};

      // Use i18n.exists() as the sole source of truth for state. Comparing
      // value against key would mis-report "missing" because the runtime's
      // parseMissingKeyHandler humanizes the leaf instead of returning the
      // raw key (so value !== key even when the key is absent).
      const inLng = i18n.exists(key, { ...existsOptions, lng, fallbackLng: false });
      const inEn = inLng
        ? false
        : i18n.exists(key, {
            ...existsOptions,
            lng: "en",
            fallbackLng: false,
          });
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
    [debugEnabled, i18n, nsKey, rawT, stableNs]
  );

  return { t, i18n, ready };
}

export default useT;
