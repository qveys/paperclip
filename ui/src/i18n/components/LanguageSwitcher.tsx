import { useCallback, useEffect, useState, type ChangeEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "../resources";

// Labels are added per language as their locale catalog lands (PRs 29-33
// in the i18n rollout). EN is the only entry at this stage; SUPPORTED_LANGUAGES
// matches, so the dropdown still lists every supported language correctly.
const LANGUAGE_LABELS: Record<SupportedLanguage, { flag: string; native: string }> = {
  en: { flag: "🇬🇧", native: "English" },
};

export interface LanguageSwitcherProps {
  /**
   * Optional id forwarded to the underlying <select>. Lets a sibling
   * <Label htmlFor=...> programmatically associate with the control so
   * clicking the label focuses it.
   */
  id?: string;
}

export function LanguageSwitcher({ id }: LanguageSwitcherProps = {}): ReactElement {
  const { t, i18n } = useTranslation();
  // i18n.resolvedLanguage is already validated against supportedLngs by the
  // LanguageDetector (which reads paperclip.locale from localStorage). Reading
  // raw localStorage here would bypass that validation and could leave the
  // <select> with an unsupported value.
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
      const previous = current;
      setCurrent(next);
      // i18next's LanguageDetector caches the resolved language to
      // localStorage (paperclip.locale) on changeLanguage, so no manual
      // storage write is needed here. On rejection, flip the engine
      // back too: by the time the promise settles, i18next may already
      // have mutated its internal language and persisted via the detector.
      void i18n.changeLanguage(next).catch((changeError: unknown) => {
        // Race guard: if the user already picked another language while
        // changeLanguage(next) was inflight, prev !== next and we leave
        // the newer choice untouched.
        setCurrent((prev) => {
          if (prev !== next) return prev;
          void i18n.changeLanguage(previous).catch((rollbackError: unknown) => {
            // Both the forward change and the rollback failed; surface
            // it instead of silently lying about UI state, and re-sync
            // the <select> to whatever i18next actually settled on.
            console.error("i18n: changeLanguage failed and rollback failed", {
              changeError,
              rollbackError,
              next,
              previous,
            });
            setCurrent(i18n.resolvedLanguage ?? i18n.language ?? previous);
          });
          return previous;
        });
      });
    },
    [current, i18n]
  );

  return (
    <select
      id={id}
      aria-label={t("core:language", { defaultValue: "Language" })}
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
