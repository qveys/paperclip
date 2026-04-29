import { useEffect } from "react";
import { useI18nDebug } from "../hooks/useI18nDebug";
import "../debug-overlay.css";

export function I18nDebugStyles(): null {
  const { enabled } = useI18nDebug();

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (enabled) {
      document.documentElement.setAttribute("data-i18n-debug", "on");
    } else {
      document.documentElement.removeAttribute("data-i18n-debug");
    }
    // Always strip on unmount so React 18 StrictMode double-mounts in dev,
    // or component teardown while enabled, never leave the debug attribute
    // stuck on <html>.
    return () => {
      document.documentElement.removeAttribute("data-i18n-debug");
    };
  }, [enabled]);

  return null;
}

export default I18nDebugStyles;
