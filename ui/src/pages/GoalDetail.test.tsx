// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TestI18nProvider } from "../test/TestI18nProvider";
import { GoalPropertiesToggleButton } from "./GoalDetail";

describe("GoalPropertiesToggleButton", () => {
  it("shows the reopen control when the properties panel is hidden", () => {
    const html = renderToStaticMarkup(
      <TestI18nProvider>
        <GoalPropertiesToggleButton panelVisible={false} onShowProperties={() => {}} />
      </TestI18nProvider>,
    );

    expect(html).toContain('title="Show properties"');
    expect(html).toContain("opacity-100");
  });

  it("collapses the reopen control while the properties panel is already visible", () => {
    const html = renderToStaticMarkup(
      <TestI18nProvider>
        <GoalPropertiesToggleButton panelVisible onShowProperties={() => {}} />
      </TestI18nProvider>,
    );

    expect(html).toContain("opacity-0");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("w-0");
  });
});
