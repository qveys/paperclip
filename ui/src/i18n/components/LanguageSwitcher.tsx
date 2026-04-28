import { useCallback, useEffect, useState, type ChangeEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "../resources";

const LOCALE_KEY = "paperclip.locale";

// Labels are added per language as their locale catalog lands (PRs 29-33
// in the i18n rollout). EN is the only entry at this stage; SUPPORTED_LANGUAGES
// matches, so the dropdown still lists every supported language correctly.
const LANGUAGE_LABELS: Record<SupportedLanguage, { flag: string; native: string }> = {
  en: { flag: "🇬🇧", native: "English" },
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
  const [current, setCurrent] = useState<string>(
    () => readPersistedLng() ?? i18n.resolvedLanguage ?? i18n.language ?? "en"
  );

  useEffect(() => {
    const syncFromI18n = (lng: string) => setCurrent(lng);
    i18n.on("languageChanged", syncFromI18n);
    return () => {
      i18n.off("languageChanged", syncFromI18n);
    };
  }, [i18n]);

  const onChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const next = event.target.value;
      const previous = current;
      setCurrent(next);
      try {
        window.localStorage.setItem(LOCALE_KEY, next);
      } catch {
        /* storage unavailable */
      }
      void i18n.changeLanguage(next).catch(() => {
        setCurrent(previous);
        try {
          window.localStorage.setItem(LOCALE_KEY, previous);
        } catch {
          /* storage unavailable */
        }
      });
    },
    [current, i18n]
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
