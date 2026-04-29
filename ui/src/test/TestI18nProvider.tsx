import { useMemo, type ReactNode } from "react";
import i18next, { type i18n as I18n, type ResourceLanguage } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { NAMESPACES, bundledResources } from "../i18n/resources";

/**
 * Vitest helper: wraps children in an isolated i18next instance backed by the
 * bundled EN catalog only. Importing the production singleton from `../i18n`
 * would pull in the chained HttpBackend + LanguageDetector and may trigger
 * network fetches in tests; this provider sidesteps that by building a fresh
 * in-memory instance per render tree (or accepts a caller-supplied one).
 */
export function TestI18nProvider({
  children,
  i18n,
}: {
  children: ReactNode;
  i18n?: I18n;
}) {
  const instance = useMemo(() => i18n ?? createTestI18n(), [i18n]);
  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}

function createTestI18n(): I18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    supportedLngs: ["en"],
    ns: [...NAMESPACES],
    defaultNS: "core",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    resources: {
      en: bundledResources.en as unknown as Record<string, ResourceLanguage>,
    },
  });
  return instance;
}
