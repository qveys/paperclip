import i18n from "i18next";
import ChainedBackend from "i18next-chained-backend";
import { initReactI18next } from "react-i18next";
import HttpBackend from "i18next-http-backend";
import LanguageDetector from "i18next-browser-languagedetector";
import resourcesToBackend from "i18next-resources-to-backend";
import { bundledResources, NAMESPACES, SUPPORTED_LANGUAGES } from "./resources";

const WEBLATE_BASE =
  (import.meta.env.VITE_PAPERCLIP_I18N_BACKEND_URL as string | undefined) ??
  "https://hosted.weblate.org/api/translations/paperclip";

i18n
  .use(ChainedBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED_LANGUAGES],
    load: "currentOnly",
    ns: [...NAMESPACES],
    defaultNS: "core",
    backend: {
      backends: [HttpBackend, resourcesToBackend(bundledResources)],
      backendOptions: [
        {
          loadPath: `${WEBLATE_BASE}/{{ns}}/{{lng}}/file/?format=json`,
          requestOptions: {
            cache: "default",
          },
        },
        {},
      ],
    },
    interpolation: { escapeValue: false },
    returnEmptyString: false,
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
