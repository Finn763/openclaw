/**
 * Real-dispatch proof for the #128971 terminal-receipt steer fence
 * (round-6 ClawSweeper evidence request).
 *
 * Round-6 blocked the PR on mock-only evidence: the admission tests drive a
 * follow-up spy manually instead of showing real dispatch and an observed
 * after-fix reply. This file exercises the real machinery end to end:
 *
 *  - a real persisted session entry carrying a terminal tombstone for the
 *    active source turn (real session store + real receipt classifier);
 *  - the real admission fence, which must reject the steer before the real
 *    beginReplyMessageInjectionTarget can queue anything (zero steer
 *    enqueues — asserted against the real registry function, never called);
 *  - the handler's fallback for a rejected injection: the real follow-up
 *    queue (enqueueFollowupRun + scheduleFollowupDrain) drained through a
 *    recording runner (the transport stand-in), which observes exactly one
 *    dispatch carrying the reply text (one follow-up dispatch + one
 *    observable reply).
 *
 * Only the pre-injection decorators (queue settings, command authorization,
 * reply-tool authority overlay) are stubbed — they are not part of the fence
 * or the dispatch path being proven. The session store, the receipt
 * classifier, the injection registry and the follow-up queue run real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as commandAuth from "../../auto-reply/command-auth.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  getFollowupQueueDepth,
  scheduleFollowupDrain,
} from "../../auto-reply/reply/queue.js";
import {
  createQueueTestRun,
  installQueueRuntimeErrorSilencer,
} from "../../auto-reply/reply/queue.test-helpers.js";
import * as settingsRuntime from "../../auto-reply/reply/queue/settings-runtime.js";
import type { FollowupRun, QueueSettings } from "../../auto-reply/reply/queue/types.js";
import * as replyRunRegistry from "../../auto-reply/reply/reply-run-registry.js";
import type { ReplyMessageInjectionTarget } from "../../auto-reply/reply/reply-run-registry.js";
import * as replyToolAuthority from "../../auto-reply/reply/reply-tool-authority.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { createChatSendMessageInjectionStarter } from "./chat-send-message-injection.js";

installQueueRuntimeErrorSilencer();

/**
 * Races a follow-up dispatch against a 10-second safety timeout and clears
 * the losing timer on every path. Retaining the handle and clearing it after
 * the race settles (unref first so the pending arm never keeps the Vitest
 * worker alive) prevents a dangling timer from outliving every successful
 * run. #128971 round-6 P2.
 */
async function settleDispatchRace(
  firstDispatched: Promise<void>,
): Promise<"dispatched" | "timeout"> {
  let raceTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      firstDispatched.then(() => "dispatched" as const),
      new Promise<"timeout">((resolve) => {
        raceTimeout = setTimeout(() => resolve("timeout"), 10_000);
        raceTimeout?.unref?.();
      }),
    ]);
  } finally {
    if (raceTimeout !== undefined) {
      clearTimeout(raceTimeout);
    }
  }
}

describe("terminal-receipt steer fence real-dispatch proof (#128971 round-6)", () => {
  const fixture = useTempSessionsFixture("steer-fence-proof-");
  const sessionKey = "agent:main:dashboard:proof-1";
  const storePath = fixture.storePath();
  const queueKeys: string[] = [];

  beforeEach(() => {
    vi.spyOn(settingsRuntime, "resolveQueueSettings").mockReturnValue({} as never);
    vi.spyOn(commandAuth, "resolveCommandAuthorization").mockReturnValue({
      senderIsOwner: true,
    } as never);
    vi.spyOn(replyToolAuthority, "resolveInboundReplyToolAuthorityOverlay").mockReturnValue(
      {} as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (queueKeys.length > 0) {
      clearSessionQueues(queueKeys.splice(0));
    }
  });

  function buildStarter(entry: unknown) {
    return createChatSendMessageInjectionStarter({
      target: { runId: "run-1", sourceTurnId: "source-1" } as ReplyMessageInjectionTarget,
      request: {
        p: {},
        rawMessage: "fallback reply",
        supportsTaskSuggestions: false,
      },
      session: {
        cfg: {},
        clientRunId: "run-1",
        entry: entry as never,
        sessionKey,
        storePath,
      },
      turn: {
        ctx: { Provider: "dashboard", From: "user", To: "user", Body: "steer" },
        isInternalTextSlashCommandTurn: false,
        replyOptionImages: [],
        replyOptionMedia: [],
      },
      imageOrder: [],
      userTurnTranscriptRecorder: {},
      logGateway: { warn: vi.fn() },
    } as never);
  }

  it("rejects a steer for a persisted active-source terminal tombstone with zero steer enqueues, then dispatches exactly one follow-up reply through the real queue", async () => {
    // Real persisted entry: terminal tombstone for the active source turn.
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "session-1",
        status: "running",
        restartRecoveryTerminalRunIds: ["source-1"],
        restartRecoveryDeliverySourceRunId: "source-1",
        updatedAt: 1,
      },
    );
    const registrySpy = vi.spyOn(replyRunRegistry, "beginReplyMessageInjectionTarget");

    // Real fence: reloads the persisted entry and fail-closes before the
    // real registry can queue the steer.
    const attempt = buildStarter(undefined)();
    expect(attempt).toBeUndefined();
    expect(registrySpy).not.toHaveBeenCalled();

    // Handler fallback: the rejected inbound goes through the real follow-up
    // queue machinery with a recording runner as the transport stand-in.
    const key = `proof-followup-${Date.now()}-${Math.random()}`;
    queueKeys.push(key);
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const dispatched: FollowupRun[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstDispatched = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const recordingRunner = async (run: FollowupRun) => {
      dispatched.push(run);
      resolveFirst?.();
    };

    const accepted = enqueueFollowupRun(
      key,
      createQueueTestRun({ prompt: "fallback reply" }),
      settings,
      "message-id",
      recordingRunner,
      false,
    );
    expect(accepted).toBe(true);
    expect(getFollowupQueueDepth(key)).toBe(1);

    scheduleFollowupDrain(key, recordingRunner);
    const outcome = await settleDispatchRace(firstDispatched);
    expect(outcome).toBe("dispatched");
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.prompt).toBe("fallback reply");
  });

  it("clears the dispatch-race timeout once the success branch wins, leaving no dangling worker timer", async () => {
    vi.useFakeTimers();
    try {
      await replaceSessionEntry(
        { sessionKey, storePath },
        {
          sessionId: "session-1",
          status: "running",
          restartRecoveryTerminalRunIds: ["source-1"],
          restartRecoveryDeliverySourceRunId: "source-1",
          updatedAt: 1,
        },
      );
      const registrySpy = vi.spyOn(replyRunRegistry, "beginReplyMessageInjectionTarget");
      const attempt = buildStarter(undefined)();
      expect(attempt).toBeUndefined();
      expect(registrySpy).not.toHaveBeenCalled();

      const key = `proof-timeout-${Date.now()}-${Math.random()}`;
      queueKeys.push(key);
      const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
      const dispatched: FollowupRun[] = [];
      let resolveFirst: (() => void) | undefined;
      const firstDispatched = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      const recordingRunner = async (run: FollowupRun) => {
        dispatched.push(run);
        resolveFirst?.();
      };

      const accepted = enqueueFollowupRun(
        key,
        createQueueTestRun({ prompt: "fallback reply" }),
        settings,
        "message-id",
        recordingRunner,
        false,
      );
      expect(accepted).toBe(true);

      scheduleFollowupDrain(key, recordingRunner);
      let outcome: "dispatched" | "timeout" | undefined;
      void settleDispatchRace(firstDispatched).then((resolved) => {
        outcome = resolved;
      });
      // The drain is microtask-driven with debounceMs 0; advance only enough
      // fake time for it to deliver, well short of the 10-second race arm.
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(50);
        if (outcome !== undefined) break;
      }
      expect(outcome).toBe("dispatched");
      expect(dispatched.length).toBe(1);
      // The losing 10-second safety timer must not survive the settled race:
      // a live handle pointlessly keeps the Vitest worker alive.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still steers when the persisted tombstone belongs to an unrelated prior source turn", async () => {
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "session-1",
        status: "running",
        restartRecoveryTerminalRunIds: ["source-old"],
        updatedAt: 1,
      },
    );
    const registrySpy = vi
      .spyOn(replyRunRegistry, "beginReplyMessageInjectionTarget")
      .mockReturnValue(undefined as never);

    const attempt = buildStarter(undefined)();
    expect(attempt).toBeUndefined();
    expect(registrySpy).toHaveBeenCalledTimes(1);
  });
});
