/** Covers steer finalize audit honesty: aborted unconfirmed commits must not audit as completed. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitInboundMessageAuditTerminal } from "../../auto-reply/reply/dispatch-from-config.audit.js";
import {
  finalizeReplyMessageInjectionAttempt,
  type ReplyMessageInjectionTarget,
} from "../../auto-reply/reply/reply-run-registry.js";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { logMessageProcessed } from "../../logging/diagnostic.js";
import { finalizeAcceptedChatSendMessageInjection } from "./chat-send-message-injection.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../../auto-reply/reply/dispatch-from-config.audit.js", () => ({
  emitInboundMessageAuditTerminal: vi.fn(),
}));
vi.mock("../../auto-reply/reply/reply-run-registry.js", () => ({
  beginReplyMessageInjectionTarget: vi.fn(),
  finalizeReplyMessageInjectionAttempt: vi.fn(),
}));
vi.mock("../../auto-reply/reply/message-received-hooks.js", () => ({
  emitMessageReceivedHooks: vi.fn(),
}));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: vi.fn(() => null),
  updateSessionEntry: vi.fn(async () => undefined),
}));
vi.mock("../../logging/diagnostic.js", () => ({
  logMessageProcessed: vi.fn(),
  logMessageReceived: vi.fn(),
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => undefined),
}));
vi.mock("./chat-broadcast.js", () => ({
  broadcastChatFinal: vi.fn(),
}));
vi.mock("../agent-turn/agent-job.js", () => ({
  setGatewayDedupeEntry: vi.fn(),
}));

function makeParams() {
  const context = {
    logGateway: { warn: vi.fn() },
    chatRunState: { hasAbortMarker: () => true },
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
  return {
    context,
    ctx: { Provider: "dashboard", From: "user", To: "user", Body: "steer" },
    attempt: {},
    persistUserTurnTranscriptBestEffort: vi.fn(async () => undefined),
    session: {
      agentId: "main",
      cfg: {},
      clientRunId: "run-1",
      entry: undefined,
      sessionKey: "agent:main:dashboard:s",
      storePath: "/tmp/nowhere.json",
    },
    startedAt: Date.now(),
    target: {} as ReplyMessageInjectionTarget,
  } as unknown as Parameters<typeof finalizeAcceptedChatSendMessageInjection>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("finalizeAcceptedChatSendMessageInjection", () => {
  it("audits a confirmed steer as completed active_run_injected", async () => {
    vi.mocked(finalizeReplyMessageInjectionAttempt).mockResolvedValueOnce({
      status: "accepted",
      outcome: { status: "accepted" },
      targetRunId: "run-1",
      aborted: false,
    });
    await finalizeAcceptedChatSendMessageInjection(makeParams());

    expect(logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", reason: "active_run_injected" }),
    );
    expect(emitInboundMessageAuditTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: { outcome: "completed", options: { reason: "active_run_injected" } },
      }),
    );
    expect(updateSessionEntry).toHaveBeenCalledOnce();
  });

  it("audits an unconfirmed-transcript steer abort as skipped, not completed", async () => {
    vi.mocked(finalizeReplyMessageInjectionAttempt).mockResolvedValueOnce({
      status: "accepted",
      outcome: {
        status: "accepted",
        result: { transcriptCommit: "unconfirmed", errorMessage: "commit timeout" },
      },
      targetRunId: "run-1",
      aborted: true,
    });
    await finalizeAcceptedChatSendMessageInjection(makeParams());

    expect(logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "skipped", reason: "reply_operation_aborted" }),
    );
    expect(emitInboundMessageAuditTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: { outcome: "skipped", options: { reason: "reply_operation_aborted" } },
      }),
    );
  });

  it("rejects acceptance when the session entry fail-closes terminal source-reply delivery", async () => {
    // A terminal receipt means a steer accepted into this turn would reuse a
    // fail-closed source-reply claim and lose the inbound's reply (#128971).
    // The acceptance must be refused so the inbound falls back to next-turn
    // admission instead of being injected into the live run.
    const params = makeParams();
    params.session.entry = {
      sessionId: "session-1",
      status: "running",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryToolCallId: "message-call-1",
      updatedAt: 1,
    } as never;

    await expect(finalizeAcceptedChatSendMessageInjection(params)).resolves.toBe(false);

    expect(vi.mocked(finalizeReplyMessageInjectionAttempt)).not.toHaveBeenCalled();
    expect(updateSessionEntry).not.toHaveBeenCalled();
    expect(params.context.logGateway.warn).toHaveBeenCalled();
  });

  it("revalidates the terminal receipt state immediately before finalizing", async () => {
    // The entry captured during prepareChatSendSession predates asynchronous
    // dispatch. A terminal receipt committed in between must still fence the
    // steer: the captured snapshot is clean, but the latest persisted entry
    // fail-closes terminal delivery, so acceptance must be refused (#128971).
    const params = makeParams();
    params.session.entry = {
      sessionId: "session-1",
      status: "running",
      updatedAt: 1,
    } as never;
    vi.mocked(loadSessionEntry).mockReturnValueOnce({
      sessionId: "session-1",
      status: "running",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
      restartRecoveryDeliveryReceiptState: "delivered-terminal",
      updatedAt: 2,
    } as never);

    await expect(finalizeAcceptedChatSendMessageInjection(params)).resolves.toBe(false);

    expect(vi.mocked(finalizeReplyMessageInjectionAttempt)).not.toHaveBeenCalled();
    expect(updateSessionEntry).not.toHaveBeenCalled();
    expect(params.context.logGateway.warn).toHaveBeenCalled();
  });

  it("prefers the latest persisted entry over the stale dispatch snapshot", async () => {
    // The opposite ordering: the captured snapshot fail-closed after dispatch,
    // but the latest persisted entry is startable again (terminal intent
    // cancelled). The fence must follow the latest state and accept the steer.
    const params = makeParams();
    params.session.entry = {
      sessionId: "session-1",
      status: "running",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryToolCallId: "message-call-1",
      updatedAt: 1,
    } as never;
    vi.mocked(loadSessionEntry).mockReturnValueOnce({
      sessionId: "session-1",
      status: "running",
      updatedAt: 2,
    } as never);
    vi.mocked(finalizeReplyMessageInjectionAttempt).mockResolvedValueOnce({
      status: "accepted",
      outcome: { status: "accepted" },
      targetRunId: "run-1",
      aborted: false,
    });

    await expect(finalizeAcceptedChatSendMessageInjection(params)).resolves.toBe(true);

    expect(vi.mocked(finalizeReplyMessageInjectionAttempt)).toHaveBeenCalledOnce();
  });
});
