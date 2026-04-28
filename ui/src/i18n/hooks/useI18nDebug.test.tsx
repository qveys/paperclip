// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useI18nDebug } from "./useI18nDebug";

const DEBUG_KEY = "paperclip.i18n.debug";

function Probe() {
  const { enabled, setEnabled, toggle } = useI18nDebug();
  return (
    <div>
      <span data-testid="state">{enabled ? "on" : "off"}</span>
      <button data-testid="toggle" onClick={toggle}>
        toggle
      </button>
      <button data-testid="enable" onClick={() => setEnabled(true)}>
        enable
      </button>
      <button data-testid="disable" onClick={() => setEnabled(false)}>
        disable
      </button>
    </div>
  );
}

afterEach(() => {
  window.localStorage.removeItem(DEBUG_KEY);
  cleanup();
});

describe("useI18nDebug", () => {
  it("defaults to disabled", () => {
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("state").textContent).toBe("off");
  });

  it("reads localStorage debug flag on mount", () => {
    window.localStorage.setItem(DEBUG_KEY, "1");
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("state").textContent).toBe("on");
  });

  it("setEnabled persists state", () => {
    const { getByTestId } = render(<Probe />);
    act(() => getByTestId("enable").click());
    expect(getByTestId("state").textContent).toBe("on");
    expect(window.localStorage.getItem(DEBUG_KEY)).toBe("1");
    act(() => getByTestId("disable").click());
    expect(getByTestId("state").textContent).toBe("off");
    expect(window.localStorage.getItem(DEBUG_KEY)).toBeNull();
  });

  it("Ctrl+Shift+L toggles debug", () => {
    const { getByTestId } = render(<Probe />);
    act(() => fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: "L" }));
    expect(getByTestId("state").textContent).toBe("on");
    act(() => fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: "L" }));
    expect(getByTestId("state").textContent).toBe("off");
  });
});
