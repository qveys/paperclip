import { defineConfig } from "i18next-cli";

export default defineConfig({
  locales: ["en"],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    ignore: ["src/**/*.test.{ts,tsx}", "src/**/*.stories.{ts,tsx}"],
    output: "src/i18n/locales/{{language}}/{{namespace}}.json",
    outputFormat: "json",
    defaultNS: "core",
    functions: ["t"],
    useTranslationNames: ["useTranslation", "useT"],
    transComponents: ["Trans"],
    keySeparator: ".",
    nsSeparator: ":",
    sort: true,
    indentation: 2,
    primaryLanguage: "en",
    secondaryLanguages: [],
    defaultValue: "",
    // Do NOT remove unused keys: removal = explicit PR,
    // not a side-effect of the parser. Avoids losing translations on Weblate.
    removeUnusedKeys: false,
  },
});
