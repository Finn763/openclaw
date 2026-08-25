import { describe, expect, it } from "vitest";
import {
  resolveRequiredCompletionDeliveryFailureTerminalResult,
  resolveRequiredCompletionTerminalResult,
} from "./task-completion-contract.js";

describe("task completion delivery failures", () => {
  it("keeps the bounded failure reason UTF-16 well-formed", () => {
    const result = resolveRequiredCompletionDeliveryFailureTerminalResult(
      `${"x".repeat(158)}🚀tail`,
    );

    expect(result.terminalSummary).toContain(`${"x".repeat(158)}...`);
    expect(result.terminalSummary).not.toContain("\uD83D");
  });
});

describe("required completion terminal results", () => {
  it("does not block a complete final report glued to narration without a space after the period", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "I'll start by mapping the repo.There's no unit-test target yet.PinPoints now has a real XCTest unit-test target and a deterministic UI smoke suite.Product code was not changed.",
    );

    expect(result.terminalOutcome).toBeUndefined();
  });

  it("recognizes sentence boundaries in glued ACP transcripts (issue #129222)", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "I'll run the unit tests against existing models and launch-argument hooks.Targets are wired in. Next I'll run the unit tests on a booted simulator, then the UI smoke suite.PinPoints now has a real XCTest unit-test target and a deterministic UI smoke suite. Product code was not changed.",
    );

    expect(result.terminalOutcome).toBeUndefined();
  });

  it("still blocks progress-only narration with glued sentence terminators", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "I'll start by mapping the repo.I'll check the dependencies.I'll run the tests next.",
    );

    expect(result.terminalOutcome).toBe("blocked");
    expect(result.terminalSummary).toContain("progress-only");
  });
});
