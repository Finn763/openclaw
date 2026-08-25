import { describe, expect, it } from "vitest";
import {
  beginRestartRecoveryTerminalDelivery,
  cancelRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery,
  isRestartRecoveryTerminalDeliveryFailClosed,
} from "./restart-recovery-receipt.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

describe("restart recovery terminal delivery receipt", () => {
  const fixture = useTempSessionsFixture("restart-receipt-");
  const sessionKey = "agent:main:discord:direct:123";

  async function seedClaim(params?: { sessionId?: string; sourceTurnId?: string }) {
    await replaceSessionEntry(
      { sessionKey, storePath: fixture.storePath() },
      {
        sessionId: params?.sessionId ?? "session-1",
        status: "running",
        restartRecoveryDeliveryRunId: "recovery-1",
        restartRecoveryDeliverySourceRunId: params?.sourceTurnId ?? "source-1",
        updatedAt: 1,
      },
    );
  }

  function scope(params?: { sessionId?: string; sourceTurnId?: string }) {
    return {
      sessionId: params?.sessionId ?? "session-1",
      sessionKey,
      sourceTurnId: params?.sourceTurnId ?? "source-1",
      storePath: fixture.storePath(),
      toolCallId: "message-call-1",
    };
  }

  it("persists pending before delivery and completion after provider success", async () => {
    await seedClaim();

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("started");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBe("terminal-pending");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryToolCallId,
    ).toBe("message-call-1");

    await expect(completeRestartRecoveryTerminalDelivery(scope())).resolves.toBe("recorded");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBe("delivered-terminal");
  });

  it("blocks a repeated terminal send while its outcome is already durable", async () => {
    await seedClaim();
    await beginRestartRecoveryTerminalDelivery(scope());

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("delivery-ambiguous");
  });

  it.each([undefined, "done" as const])(
    "does not arm a receipt for a live claimless turn with status %s",
    async (status) => {
      await replaceSessionEntry(
        { sessionKey, storePath: fixture.storePath() },
        {
          sessionId: "session-1",
          status,
          updatedAt: 1,
        },
      );

      await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("not-applicable");
      expect(
        loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
          ?.restartRecoveryDeliveryReceiptState,
      ).toBeUndefined();
    },
  );

  it("fails closed when the claimless live capability names a replaced session", async () => {
    await replaceSessionEntry(
      { sessionKey, storePath: fixture.storePath() },
      {
        sessionId: "session-2",
        updatedAt: 1,
      },
    );

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
  });

  it("blocks a completed source after its active recovery claim is cleared", async () => {
    await replaceSessionEntry(
      { sessionKey, storePath: fixture.storePath() },
      {
        sessionId: "session-1",
        restartRecoveryTerminalRunIds: ["source-1"],
        updatedAt: 1,
      },
    );

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("already-delivered");
  });

  it("clears pending only after a proven non-delivery", async () => {
    await seedClaim();
    await beginRestartRecoveryTerminalDelivery(scope());

    await expect(cancelRestartRecoveryTerminalDelivery(scope())).resolves.toBe("cleared");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBeUndefined();
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryToolCallId,
    ).toBeUndefined();
  });

  it("does not mutate a replacement session", async () => {
    await seedClaim({ sessionId: "session-2", sourceTurnId: "source-2" });

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    await expect(completeRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    await expect(cancelRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBeUndefined();
  });
});

describe("restart recovery terminal delivery fail-closed classification", () => {
  function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return { sessionId: "session-1", updatedAt: 1, ...overrides } as SessionEntry;
  }

  it("is fail-closed for a terminal-pending receipt", () => {
    expect(
      isRestartRecoveryTerminalDeliveryFailClosed(
        entry({
          status: "running",
          restartRecoveryDeliveryRunId: "recovery-1",
          restartRecoveryDeliverySourceRunId: "source-1",
          restartRecoveryDeliveryReceiptState: "terminal-pending",
          restartRecoveryDeliveryToolCallId: "message-call-1",
        }),
        "session-1",
      ),
    ).toBe(true);
  });

  it("is fail-closed for a delivered-terminal receipt", () => {
    expect(
      isRestartRecoveryTerminalDeliveryFailClosed(
        entry({
          status: "running",
          restartRecoveryDeliveryRunId: "recovery-1",
          restartRecoveryDeliverySourceRunId: "source-1",
          restartRecoveryDeliveryReceiptState: "delivered-terminal",
          restartRecoveryDeliveryToolCallId: "message-call-1",
        }),
        "session-1",
      ),
    ).toBe(true);
  });

  it("is fail-closed for an unresolved terminal tool-call id without a receipt state", () => {
    expect(
      isRestartRecoveryTerminalDeliveryFailClosed(
        entry({
          status: "running",
          restartRecoveryDeliveryRunId: "recovery-1",
          restartRecoveryDeliverySourceRunId: "source-1",
          restartRecoveryDeliveryToolCallId: "message-call-2",
        }),
        "session-1",
      ),
    ).toBe(true);
  });

  it("is fail-closed for a terminal-source tombstone after claim cleanup", () => {
    expect(
      isRestartRecoveryTerminalDeliveryFailClosed(
        entry({ status: "running", restartRecoveryTerminalRunIds: ["source-1"] }),
        "session-1",
      ),
    ).toBe(true);
  });

  it("is fail-closed for a stale claim", () => {
    expect(
      isRestartRecoveryTerminalDeliveryFailClosed(
        entry({
          status: "done",
          restartRecoveryDeliveryRunId: "recovery-1",
          restartRecoveryDeliverySourceRunId: "source-1",
        }),
        "session-1",
      ),
    ).toBe(true);
  });

  it("is fail-closed when the entry names a replaced session", () => {
    expect(
      isRestartRecoveryTerminalDeliveryFailClosed(
        entry({
          status: "running",
          sessionId: "session-2",
          restartRecoveryTerminalRunIds: ["source-1"],
        }),
        "session-1",
      ),
    ).toBe(true);
  });

  it("is not fail-closed for a claimless fresh entry", () => {
    expect(
      isRestartRecoveryTerminalDeliveryFailClosed(entry({ status: "running" }), "session-1"),
    ).toBe(false);
  });

  it("is not fail-closed for a startable live claim", () => {
    expect(
      isRestartRecoveryTerminalDeliveryFailClosed(
        entry({
          status: "running",
          restartRecoveryDeliveryRunId: "recovery-1",
          restartRecoveryDeliverySourceRunId: "source-1",
        }),
        "session-1",
      ),
    ).toBe(false);
  });

  it("is not fail-closed without a session entry", () => {
    expect(isRestartRecoveryTerminalDeliveryFailClosed(undefined, "session-1")).toBe(false);
  });
});
