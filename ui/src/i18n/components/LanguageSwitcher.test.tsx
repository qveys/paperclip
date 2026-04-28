// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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
  it("renders all 6 languages with flags + native names", () => {
    const { container } = renderSwitcher();
    const options = Array.from(container.querySelectorAll("option")).map(
      (o) => o.textContent
    );
    expect(options).toEqual(
      expect.arrayContaining([
        expect.stringContaining("🇬🇧"),
        expect.stringContaining("English"),
        expect.stringContaining("🇫🇷"),
        expect.stringContaining("Français"),
        expect.stringContaining("🇨🇳"),
        expect.stringContaining("中文"),
        expect.stringContaining("🇯🇵"),
        expect.stringContaining("日本語"),
        expect.stringContaining("🇪🇸"),
        expect.stringContaining("Español"),
        expect.stringContaining("🇩🇪"),
        expect.stringContaining("Deutsch"),
      ])
    );
    expect(options.length).toBe(6);
  });

  it("has a value bound to the current resolved language", async () => {
    await act(async () => {
      await testI18n.changeLanguage("fr-FR");
    });
    const { container } = renderSwitcher();
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("fr-FR");
  });

  it("calls i18n.changeLanguage and writes localStorage on change", async () => {
    await act(async () => {
      await testI18n.changeLanguage("en");
    });
    const { container } = renderSwitcher();
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "de-DE" } });
    });
    expect(testI18n.language).toBe("de-DE");
    expect(window.localStorage.getItem(LOCALE_KEY)).toBe("de-DE");
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
