// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nDebugStyles } from "./I18nDebugStyles";

const DEBUG_KEY = "paperclip.i18n.debug";

afterEach(() => {
  window.localStorage.removeItem(DEBUG_KEY);
  document.documentElement.removeAttribute("data-i18n-debug");
  cleanup();
});

describe("I18nDebugStyles", () => {
  it("does not set html data attribute when disabled", () => {
    render(<I18nDebugStyles />);
    expect(document.documentElement.getAttribute("data-i18n-debug")).toBeNull();
  });

  it("sets html data attribute when debug is enabled", () => {
    window.localStorage.setItem(DEBUG_KEY, "1");
    render(<I18nDebugStyles />);
    expect(document.documentElement.getAttribute("data-i18n-debug")).toBe("on");
  });

  it("updates html data attribute via storage events", () => {
    render(<I18nDebugStyles />);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: DEBUG_KEY, newValue: "1" }));
    });
    expect(document.documentElement.getAttribute("data-i18n-debug")).toBe("on");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: DEBUG_KEY, newValue: null }));
    });
    expect(document.documentElement.getAttribute("data-i18n-debug")).toBeNull();
  });
});
