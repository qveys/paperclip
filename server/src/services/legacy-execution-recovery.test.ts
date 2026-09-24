import { expect, it } from "vitest";
import { legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";

const stopped = {
  runtimeMode: "legacy", status: "cancelled", errorCode: "cancelled",
  resultJson: {
    executionCancellation: { state: "acknowledged" },
    executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
  },
};

it("allows a confirmed interrupted checkpoint without treating ordinary cancellation as replay permission", () => {
  expect(legacyExecutionNeedsReconciliation(stopped)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, status: "failed" })).toBe(true);
});

it.each([
  { providerStopped: false }, { sessionPreserved: false }, { actionOutcomes: "unknown" },
])("retains the hold for incomplete interruption evidence: %j", (missing) => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson,
    executionRecovery: { ...stopped.resultJson.executionRecovery, ...missing },
  } })).toBe(true);
});

it("retains the hold until the provider actually acknowledges cancellation", () => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson, executionCancellation: { state: "requested" },
  } })).toBe(true);
});
it("never holds a run that was never started, even past the retry budget", () => {
  const neverStarted = { runtimeMode: "legacy", status: "cancelled", errorCode: "issue_dependencies_blocked",
    resultJson: {}, startedAt: null, processPid: null, scheduledRetryAttempt: 3 };
  expect(legacyExecutionNeedsReconciliation(neverStarted)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...neverStarted, status: "failed", errorCode: "execution_reconciliation_required" })).toBe(false);
  // Any sign of a launched provider, or missing evidence, keeps the hold.
  expect(legacyExecutionNeedsReconciliation({ ...neverStarted, startedAt: new Date() })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...neverStarted, processPid: 4242 })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...neverStarted, startedAt: undefined })).toBe(true);
});
