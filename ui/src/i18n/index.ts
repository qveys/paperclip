import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { bundledResources, NAMESPACES, SUPPORTED_LANGUAGES } from "./resources";

// Phase 0 ships translations from a static bundle compiled into the JS. Live
// runtime fetches to hosted.weblate.org are blocked by CORS (Weblate's REST
// /file/ endpoint sets no Access-Control-Allow-Origin), so a browser-only
// HttpBackend would always fail. Translation freshness is achieved through
// CI workflows that push EN source to Weblate on master and (Phase 1+) pull
// translated catalogs back into ui/src/i18n/locales/ via a PR.

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // Inline all bundles at init. No backend, no async load — every supported
    // language is registered synchronously, so changeLanguage resolves with
    // the requested lng on the first tick.
    resources: bundledResources as Record<
      string,
      Record<string, Record<string, unknown>>
    >,
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED_LANGUAGES],
    // Load ONLY the requested language. Without this, i18next defaults to
    // load: "all" which expands "fr-FR" into ["fr-FR", "fr", "en"]. Then
    // setResolvedLanguage walks that hierarchy and the last supported entry
    // wins — so "en" silently overwrites "fr-FR" as resolvedLanguage even
    // though the user asked for fr-FR. Missing-key fallback to en still
    // works at translation lookup time via fallbackLng.
    load: "currentOnly",
    // NOTE: do NOT set nonExplicitSupportedLngs: true here. With BCP-47 codes
    // like "fr-FR" / "zh-CN" in supportedLngs, that option silently flips
    // isSupportedCode("fr-FR") to false (it strips the country code before
    // checking, so "fr-FR" is normalized to "fr" which is not in the list)
    // and changeLanguage rejects without a Promise rejection — the controlled
    // <select> snaps back to the previous value with no error logged.
    ns: [...NAMESPACES],
    defaultNS: "core",
    interpolation: { escapeValue: false },
    returnEmptyString: false,
    // No Suspense boundary in main.tsx; Suspense would throw a Promise
    // during render with no fallback. Keep useTranslation synchronous.
    react: { useSuspense: false },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "paperclip.locale",
      caches: ["localStorage"],
    },
  });

if (typeof window !== "undefined") {
  // Debug aid — exposed in dev so we can inspect language state from the
  // browser console. Safe to leave in: it's just a reference to the singleton.
  (window as unknown as { __i18n?: typeof i18n }).__i18n = i18n;
}

export default i18n;
