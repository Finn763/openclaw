import { describe, expect, it } from "vitest";
import { buildExecForegroundResult } from "./bash-tools.exec-support.js";

const RETENTION_LOSS_WORDING = "discarded at the retention cap and cannot be recovered";

describe("exec foreground retention", () => {
  it("discloses output discarded at the aggregate cap ahead of retained output", () => {
    const result = buildExecForegroundResult({
      outcome: {
        status: "completed",
        exitCode: 0,
        exitSignal: null,
        durationMs: 1,
        aggregated: "retained output",
        timedOut: false,
      },
      aggregateOutputDropped: true,
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(RETENTION_LOSS_WORDING);
    // Front-loaded so downstream head-preserving caps cannot silently drop the
    // only disclosure of output lost at the exec aggregate retention cap.
    expect(text.indexOf(RETENTION_LOSS_WORDING)).toBeLessThan(text.indexOf("retained output"));
    expect((result.details as { aggregated?: string }).aggregated).toBe("retained output");
  });

  it("front-loads the retention disclosure on failed outcomes", () => {
    const result = buildExecForegroundResult({
      outcome: {
        status: "failed",
        exitCode: 1,
        exitSignal: null,
        durationMs: 1,
        aggregated: "",
        timedOut: false,
        failureKind: "aborted",
        reason: "command rejected the request",
      },
      aggregateOutputDropped: true,
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(RETENTION_LOSS_WORDING);
    expect(text.indexOf(RETENTION_LOSS_WORDING)).toBeLessThan(
      text.indexOf("command rejected the request"),
    );
  });

  it("front-loads the retention disclosure ahead of an oversized approval warning", () => {
    const result = buildExecForegroundResult({
      outcome: {
        status: "completed",
        exitCode: 0,
        exitSignal: null,
        durationMs: 1,
        aggregated: "retained output",
        timedOut: false,
      },
      warningText: "w".repeat(80_000),
      aggregateOutputDropped: true,
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(RETENTION_LOSS_WORDING);
    // The approval warning is unbounded and must not precede (and thereby bury)
    // the front-loaded disclosure in any head-preserving downstream cap.
    expect(text.indexOf(RETENTION_LOSS_WORDING)).toBeLessThan(text.indexOf("w".repeat(20)));
  });
});
