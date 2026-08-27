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

  it("does not block a report whose only glued boundary continues with a copula (issue #129222)", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "I'll run the unit tests against existing models and launch-argument hooks.Targets are wired in.",
    );

    expect(result.terminalOutcome).toBeUndefined();
  });

  it("does not block a report whose only glued boundary opens with a sentence adverb (issue #129222)", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "I'll run the unit tests on a booted simulator, then the UI smoke suite.PinPoints now has a real XCTest unit-test target and a deterministic UI smoke suite.",
    );

    expect(result.terminalOutcome).toBeUndefined();
  });

  it("does not block a report whose only glued boundary opens with a general finite verb after now (issue #129222)", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "I'll inspect the suite.PinPoints now works.",
    );

    expect(result.terminalOutcome).toBeUndefined();
  });

  it("does not block a report whose only glued boundary opens with an inflected finite verb after now (issue #129222)", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "I'll run the unit tests on a booted simulator, then the UI smoke suite.PinPoints now passes.",
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

  it("still blocks progress-only narration ending in a structured colon token", () => {
    const result = resolveRequiredCompletionTerminalResult("I'll inspect build:README");

    expect(result.terminalOutcome).toBe("blocked");
  });

  it("still blocks mixed glued progress narration ending in a structured colon token", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "I'll start by mapping the repo.I'll inspect build:README and run the tests.",
    );

    expect(result.terminalOutcome).toBe("blocked");
  });

  it("does not block a colon-glued summary when a real glued dot boundary exists", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "I'll check the logs.Summary:Details are above.",
    );

    expect(result.terminalOutcome).toBeUndefined();
  });

  it("still blocks progress-only text with a dotted structured reference", () => {
    const result = resolveRequiredCompletionTerminalResult("I'll inspect API.Client");

    expect(result.terminalOutcome).toBe("blocked");
    expect(result.terminalSummary).toContain("progress-only");
  });

  it("still blocks progress-only text with a camelCase dotted identifier", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "I'll map foo.Bar then trace the calls.",
    );

    expect(result.terminalOutcome).toBe("blocked");
    expect(result.terminalSummary).toContain("progress-only");
  });

  it("still blocks progress-only text referencing a dotted path with known extensions", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "I'll inspect src/main.Kt and config.py next.",
    );

    expect(result.terminalOutcome).toBe("blocked");
    expect(result.terminalSummary).toContain("progress-only");
  });

  it("still blocks progress-only text with a punctuated dotted reference", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "I'll inspect API.Client, then trace the calls.",
    );

    expect(result.terminalOutcome).toBe("blocked");
    expect(result.terminalSummary).toContain("progress-only");
  });

  it("still blocks progress-only text with a punctuated camelCase dotted identifier", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "I'll map foo.Bar, and review the calls.",
    );

    expect(result.terminalOutcome).toBe("blocked");
    expect(result.terminalSummary).toContain("progress-only");
  });

  it("still blocks progress-only text when an ordinary continuation follows a dotted reference", () => {
    const result = resolveRequiredCompletionTerminalResult("I'll inspect foo.Bar results.");

    expect(result.terminalOutcome).toBe("blocked");
    expect(result.terminalSummary).toContain("progress-only");
  });

  it("still blocks progress-only text when now precedes a function word after a dotted reference", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "I'll inspect foo.Bar now and then check the tests.",
    );

    expect(result.terminalOutcome).toBe("blocked");
    expect(result.terminalSummary).toContain("progress-only");
  });
});
