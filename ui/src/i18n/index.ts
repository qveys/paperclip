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
const isDev = import.meta.env.DEV;

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
      backends: [
        HttpBackend,
        resourcesToBackend(
          bundledResources as unknown as Record<
            string,
            Record<string, Record<string, unknown>>
          >
        ),
      ],
      backendOptions: [
        {
          loadPath: `${WEBLATE_BASE}/{{ns}}/{{lng}}/file/?format=json`,
          requestOptions: {
            cache: isDev ? "no-store" : "default",
          },
        },
        {},
      ],
    },
    interpolation: { escapeValue: false },
    returnEmptyString: false,
    parseMissingKeyHandler: (key, defaultValue) => {
      if (typeof defaultValue === "string" && defaultValue.length > 0) {
        return defaultValue;
      }
      const colonIdx = key.lastIndexOf(":");
      const path = colonIdx >= 0 ? key.slice(colonIdx + 1) : key;
      const leaf = path.split(".").pop() ?? path;
      const humanized = leaf
        .replace(/_/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .trim();
      return humanized.length > 0
        ? humanized.charAt(0).toUpperCase() + humanized.slice(1)
        : key;
    },
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
