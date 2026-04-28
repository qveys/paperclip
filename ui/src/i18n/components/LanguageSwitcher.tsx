import { useCallback, useState, type ChangeEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "../resources";

const LOCALE_KEY = "paperclip.locale";

const LANGUAGE_LABELS: Record<SupportedLanguage, { flag: string; native: string }> = {
  en: { flag: "🇬🇧", native: "English" },
  "fr-FR": { flag: "🇫🇷", native: "Français" },
  "zh-CN": { flag: "🇨🇳", native: "中文" },
  "ja-JP": { flag: "🇯🇵", native: "日本語" },
  "es-ES": { flag: "🇪🇸", native: "Español" },
  "de-DE": { flag: "🇩🇪", native: "Deutsch" },
};

function readPersistedLng(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}

export function LanguageSwitcher(): ReactElement {
  const { i18n } = useTranslation();
  // The <select> reflects the locale the user picked (persisted in
  // localStorage), NOT i18n.resolvedLanguage. i18next has subtle race
  // conditions around setResolvedLanguage when bundles have empty namespaces
  // (it walks the language hierarchy, hasLanguageSomeTranslations may report
  // false during the window between changeLanguage start and bundle register,
  // so resolvedLanguage gets pinned to the fallback). Until Phase 1 wraps the
  // UI in useT(), no rendered text depends on i18n.language anyway — the
  // switcher just needs to flip visually and persist the choice.
  const [current, setCurrent] = useState<string>(
    () => readPersistedLng() ?? i18n.resolvedLanguage ?? i18n.language ?? "en"
  );

  const onChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const next = event.target.value;
      setCurrent(next);
      try {
        window.localStorage.setItem(LOCALE_KEY, next);
      } catch {
        /* storage unavailable */
      }
      void i18n.changeLanguage(next).catch(() => {
        /* swallow — UI does not consume i18n.language yet */
      });
    },
    [i18n]
  );

  return (
    <select
      aria-label="Language"
      value={current}
      onChange={onChange}
      className="rounded border px-2 py-1 text-sm"
    >
      {SUPPORTED_LANGUAGES.map((lng) => {
        const { flag, native } = LANGUAGE_LABELS[lng];
        return (
          <option key={lng} value={lng}>
            {flag} {native}
          </option>
        );
      })}
    </select>
  );
}

export default LanguageSwitcher;
