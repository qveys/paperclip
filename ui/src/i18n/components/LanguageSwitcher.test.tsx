// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import i18next, { type i18n as I18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { NAMESPACES, SUPPORTED_LANGUAGES } from "../resources";
import LanguageSwitcher from "./LanguageSwitcher";

const LOCALE_KEY = "paperclip.locale";

let testI18n: I18n;

beforeAll(async () => {
  testI18n = i18next.createInstance();
  await testI18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED_LANGUAGES],
    ns: [...NAMESPACES],
    defaultNS: "core",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    resources: { en: { core: {} } },
  });
});

afterEach(() => {
  window.localStorage.removeItem(LOCALE_KEY);
  cleanup();
});

function renderSwitcher() {
  return render(
    <I18nextProvider i18n={testI18n}>
      <LanguageSwitcher />
    </I18nextProvider>
  );
}

describe("LanguageSwitcher", () => {
  it("renders an <option> per SUPPORTED_LANGUAGES entry", () => {
    const { container } = renderSwitcher();
    const options = Array.from(container.querySelectorAll("option"));
    expect(options.length).toBe(SUPPORTED_LANGUAGES.length);
    for (const lng of SUPPORTED_LANGUAGES) {
      expect(options.some((o) => o.value === lng)).toBe(true);
    }
  });

  it("each option has non-empty visible text", () => {
    const { container } = renderSwitcher();
    const options = Array.from(container.querySelectorAll("option"));
    for (const o of options) {
      expect(o.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it("has a value bound to the current resolved language", async () => {
    await act(async () => {
      await testI18n.changeLanguage("en");
    });
    const { container } = renderSwitcher();
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("en");
  });

  it('exposes aria-label "Language" on the select for a11y', () => {
    const { container } = renderSwitcher();
    const select = container.querySelector("select");
    expect(select?.getAttribute("aria-label")).toBe("Language");
  });

  it("renders without crashing when current language is exotic", async () => {
    await act(async () => {
      await testI18n.changeLanguage("xx-YY");
    });
    expect(() => renderSwitcher()).not.toThrow();
  });
});

// Note: end-to-end change-language tests (verifying that selecting another
// option calls i18n.changeLanguage and writes localStorage) re-appear in
// PR 29 once SUPPORTED_LANGUAGES grows beyond ["en"].
