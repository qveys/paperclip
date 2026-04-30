import { useCallback, useEffect, useState, type ChangeEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "../resources";

// Labels are added per language as their locale catalog lands (PRs 29-33
// in the i18n rollout). EN is the only entry at this stage; SUPPORTED_LANGUAGES
// matches, so the dropdown still lists every supported language correctly.
const LANGUAGE_LABELS: Record<SupportedLanguage, { flag: string; native: string }> = {
  en: { flag: "🇬🇧", native: "English" },
};

export function LanguageSwitcher(): ReactElement {
  const { i18n } = useTranslation();
  // Persistence and validation against supportedLngs are handled by the
  // i18next-browser-languagedetector with caches: ["localStorage"] (see
  // ui/src/i18n/index.ts). Reading resolvedLanguage here ensures we mirror the
  // engine's view of state instead of racing with it.
  const [current, setCurrent] = useState<string>(
    () => i18n.resolvedLanguage ?? i18n.language ?? "en"
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
      const previous = i18n.resolvedLanguage ?? i18n.language ?? "en";
      setCurrent(next);
      void i18n.changeLanguage(next).catch(() => {
        // Roll back engine state too — a partial mutation can leave the
        // detector cache pointing at `next` even though the load failed.
        setCurrent(() => previous);
        void i18n.changeLanguage(previous).catch(() => {
          /* dual failure — leave the languageChanged listener to reconcile */
        });
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
