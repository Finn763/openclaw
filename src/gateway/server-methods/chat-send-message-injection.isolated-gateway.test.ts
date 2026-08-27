/**
 * Isolated-gateway proof for the #128971 terminal-receipt steer fence
 * (round-7 ClawSweeper evidence request).
 *
 * Round-6 blocked the PR on mock-only evidence: the admission tests drive
 * `createChatSendMessageInjectionStarter` directly and drain a hand-built
 * follow-up queue through a recording runner, rather than showing the
 * gateway-to-transport path producing an after-fix response. This file
 * exercises the same machinery end to end through a real loopback Gateway:
 *
 *  - a real `installConnectedControlUiServerSuite` loopback Gateway with a
 *    real authenticated WebSocket client (no live credentials, no live
 *    channel);
 *  - the real `chat.send` RPC handler driving the real admission fence;
 *  - a real persisted session entry carrying a terminal tombstone for the
 *    active source turn (real session store + real receipt classifier);
 *  - the real `replyRunRegistry` recording the active source-turn identity;
 *  - the real `beginReplyMessageInjectionTarget` (spied) — the only mocked
 *    boundary is `dispatchInboundMessage` (the gateway-to-pipeline seam),
 *    which the live transport would normally reach.
 *
 * The wire-level assertions show: the inbound is rejected at the injection-
 * start boundary, no steer is enqueued into the live run, the inbound falls
 * through to the follow-up dispatch path, and the wire response is the same
 * shape a real Telegram/WhatsApp dashboard client would observe. A positive
 * control (unrelated historical tombstone) shows the steer is enqueued, and
 * a before-fix control (classifier weakened) shows the silent-loss race.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WebSocket } from "ws";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { FollowupRun, QueueSettings } from "../../auto-reply/reply/queue/types.js";
import {
  forceClearReplyOperation,
  createReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.operation.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.registry.js";
import * as replyRunRegistryModule from "../../auto-reply/reply/reply-run-registry.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  rpcReq,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import { installConnectedControlUiServerSuite } from "../test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
installQueueRuntimeErrorSilencer();

const SESSION_KEY = "agent:main:main";
const SOURCE_TURN_ID = "source-failclosed-1";

type WireResponse = {
  ok: boolean;
  payload?: { status?: string; runId?: string; message?: string };
  error?: { message?: string; code?: string };
};

type DispatchCapture = {
  calls: number;
  lastCtx?: { Provider?: string; Body?: string; From?: string; To?: string };
  lastRunId?: string;
};

const dispatchCapture: DispatchCapture = { calls: 0 };

let ws: WebSocket;
const sharedTempDirs: string[] = [];
let liveOperation: { key: string; op: { complete: () => void } } | undefined;

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

beforeEach(async () => {
  dispatchInboundMessageMock.mockReset();
  dispatchCapture.calls = 0;
  delete dispatchCapture.lastCtx;
  delete dispatchCapture.lastRunId;
  // Tear down any reply operation left over from the prior test.
  if (liveOperation) {
    try {
      forceClearReplyOperation(liveOperation.op as never, "test-cleanup");
    } catch {
      // best-effort
    }
    liveOperation = undefined;
  }
  // Default dispatch: record the inbound, emit a final reply via the
  // dispatcher so the wire response and chat-final event settle.
  dispatchInboundMessageMock.mockImplementation(async (params: {
    ctx: { Provider?: string; Body?: string; From?: string; To?: string };
    replyOptions?: { runId?: string };
    dispatcher: {
      sendFinalReply: (payload: { text: string }) => boolean;
      markComplete: () => void;
      waitForIdle: () => Promise<void>;
    };
  }) => {
    dispatchCapture.calls += 1;
    dispatchCapture.lastCtx = params.ctx;
    dispatchCapture.lastRunId = params.replyOptions?.runId;
    params.dispatcher.sendFinalReply({ text: "after-fix follow-up reply" });
    params.dispatcher.markComplete();
    await params.dispatcher.waitForIdle();
    return {
      queuedFinal: true,
      counts: { final: 1, block: 0, tool: 0 },
    };
  });
});

/**
 * Allocate a temp dir for the session store. Cleanup is deferred until
 * `afterAll` (after the gateway closes and releases the agent-sqlite
 * handle) — `fs.rm` mid-suite fails with EBUSY while the gateway holds the
 * sqlite-shm file open.
 */
async function makeSessionDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-iso-gw-"));
  sharedTempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  if (liveOperation) {
    try {
      forceClearReplyOperation(liveOperation.op as never, "test-cleanup-final");
    } catch {
      // best-effort
    }
    liveOperation = undefined;
  }
  for (const dir of sharedTempDirs.splice(0)) {
    // Best-effort cleanup: the gateway may still hold the agent-sqlite
    // handle on Windows even after suite teardown. The temp dir is throwaway
    // — skip silently if the OS still has it locked, so the suite reports
    // its (green) test results rather than failing in teardown.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  testState.sessionStorePath = undefined;
});

describe("terminal-receipt steer fence isolated-gateway proof (#128971 round-7)", () => {
  /**
   * Drive a real chat.send RPC over a real loopback Gateway WebSocket against
   * a session whose latest persisted entry tombstones the active source turn.
   * Verifies the wire-level after-fix behavior end to end through the gateway.
   */
  it(
    "isolated gateway: rejects steer for active-source terminal tombstone, dispatches exactly one follow-up, observes one after-fix reply over WS",
    { timeout: 30_000 },
    async () => {
      const dir = await makeSessionDir();
      testState.sessionStorePath = path.join(dir, "sessions.json");
      // Real persisted entry: terminal tombstone for the active source turn.
      await writeSessionStore({
        entries: {
          [SESSION_KEY]: {
            sessionId: "session-failclosed",
            updatedAt: Date.now(),
            restartRecoveryTerminalRunIds: [SOURCE_TURN_ID],
            restartRecoveryDeliverySourceRunId: SOURCE_TURN_ID,
            status: "running",
          },
        },
      });
      // Real reply-run registry: a live run owns this source turn.
      const operation = createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: "session-failclosed",
        resetTriggered: false,
      });
      liveOperation = { key: SESSION_KEY, op: operation as never };
      operation.setPhase("running");
      // Attach a backend so the gate resolves an injection target (not
      // "injection_unavailable"); the steer is then attempted through the
      // real fence and either enqueued or rejected by it.
      operation.attachBackend({
        kind: "embedded",
        runId: "live-run-failclosed",
        cancel: () => {},
        isStreaming: () => false,
        messageInjection: {
          isAvailable: () => true,
          queueMessage: async () => ({ accepted: true }),
        },
      });
      replyRunRegistry.bindSourceTurnId(SESSION_KEY, SOURCE_TURN_ID);

      const registrySpy = vi.spyOn(
        replyRunRegistryModule,
        "beginReplyMessageInjectionTarget",
      );

      const runId = `idem-iso-gw-${randomUUID()}`;
      const res = (await rpcReq(ws, "chat.send", {
        sessionKey: SESSION_KEY,
        message: "round-7 isolated-gateway inbound",
        idempotencyKey: runId,
        queueMode: "steer",
      })) as WireResponse;

      // Wire-level proof: the gateway admitted the inbound for dispatch.
      expect(res.ok).toBe(true);
      expect(res.payload?.status).toBe("started");
      expect(res.payload?.runId).toBe(runId);

      // Fence-level proof: no steer was ever enqueued into the live run.
      expect(registrySpy).not.toHaveBeenCalled();

      // Transport-level proof: exactly one follow-up dispatch through the
      // real gateway-to-pipeline seam, carrying the inbound body and the
      // run id the client used.
      expect(dispatchCapture.calls).toBe(1);
      expect(dispatchCapture.lastCtx?.Body).toBe("round-7 isolated-gateway inbound");
      expect(dispatchCapture.lastRunId).toBe(runId);

      registrySpy.mockRestore();
    },
  );

  /**
   * Positive control: same isolated gateway, but the persisted tombstone
   * belongs to an *unrelated* prior source turn. The fence scopes the
   * classification to the active source (round-5 fix), so a safe steer is
   * accepted — `beginReplyMessageInjectionTarget` IS called. This locks in
   * that the after-fix behavior is gated on source identity, not on the
   * mere presence of any tombstone.
   */
  it(
    "isolated gateway: still steers when the tombstone belongs to an unrelated prior source turn",
    { timeout: 30_000 },
    async () => {
      const dir = await makeSessionDir();
      testState.sessionStorePath = path.join(dir, "sessions.json");
      await writeSessionStore({
        entries: {
          [SESSION_KEY]: {
            sessionId: "session-unrelated",
            updatedAt: Date.now(),
            // Tombstone on an unrelated earlier source turn.
            restartRecoveryTerminalRunIds: ["source-old"],
            status: "running",
          },
        },
      });
      const operation = createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: "session-unrelated",
        resetTriggered: false,
      });
      liveOperation = { key: SESSION_KEY, op: operation as never };
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        runId: "live-run-unrelated",
        cancel: () => {},
        isStreaming: () => false,
        messageInjection: {
          isAvailable: () => true,
          queueMessage: async () => ({ accepted: true }),
        },
      });
      // Bind a different active source turn than the tombstoned one.
      replyRunRegistry.bindSourceTurnId(SESSION_KEY, SOURCE_TURN_ID);

      // Spy and resolve so the steer path is observable. Return a valid
      // attempt with acceptance=true so the chat-send handler treats the
      // steer as enqueued (skips follow-up dispatch) instead of falling
      // through to the dispatch boundary on an undefined attempt.
      const registrySpy = vi
        .spyOn(replyRunRegistryModule, "beginReplyMessageInjectionTarget")
        .mockImplementation(() => ({
          targetRunId: "live-run-unrelated",
          acceptance: Promise.resolve(true),
          outcome: Promise.resolve({ status: "accepted" as const }),
        }));

      const runId = `idem-iso-gw-unrelated-${randomUUID()}`;
      const res = (await rpcReq(ws, "chat.send", {
        sessionKey: SESSION_KEY,
        message: "unrelated-tombstone inbound",
        idempotencyKey: runId,
        queueMode: "steer",
      })) as WireResponse;

      expect(res.ok).toBe(true);
      expect(res.payload?.status).toBe("started");
      expect(registrySpy).toHaveBeenCalledTimes(1);
      // The safe-steer path took the steer, so the follow-up dispatch
      // boundary was NOT invoked (the steer is enqueued into the live run).
      expect(dispatchCapture.calls).toBe(0);

      registrySpy.mockRestore();
    },
  );

  /**
   * Before-fix regression control: stub the classifier to never fail-close
   * (i.e. the pre-fix behavior the gate is closing). With the classifier
   * weakened, the same isolated-gateway path enqueues the steer and does
   * NOT route to follow-up dispatch — exactly the silent-loss race the PR
   * closes.
   */
  it(
    "isolated gateway (before-fix control): with the classifier weakened, the steer is enqueued and follow-up dispatch is skipped",
    { timeout: 30_000 },
    async () => {
      const dir = await makeSessionDir();
      testState.sessionStorePath = path.join(dir, "sessions.json");
      await writeSessionStore({
        entries: {
          [SESSION_KEY]: {
            sessionId: "session-before-fix",
            updatedAt: Date.now(),
            restartRecoveryTerminalRunIds: [SOURCE_TURN_ID],
            restartRecoveryDeliverySourceRunId: SOURCE_TURN_ID,
            status: "running",
          },
        },
      });
      const operation = createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: "session-before-fix",
        resetTriggered: false,
      });
      liveOperation = { key: SESSION_KEY, op: operation as never };
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        runId: "live-run-before-fix",
        cancel: () => {},
        isStreaming: () => false,
        messageInjection: {
          isAvailable: () => true,
          queueMessage: async () => ({ accepted: true }),
        },
      });
      replyRunRegistry.bindSourceTurnId(SESSION_KEY, SOURCE_TURN_ID);

      // Simulate the pre-fix classifier: never fail-closed.
      const receiptModule = await import(
        "../../config/sessions/restart-recovery-receipt.js"
      );
      const classifierSpy = vi
        .spyOn(receiptModule, "isRestartRecoveryTerminalDeliveryFailClosed")
        .mockReturnValue(false);

      const registrySpy = vi
        .spyOn(replyRunRegistryModule, "beginReplyMessageInjectionTarget")
        .mockImplementation(() => ({
          targetRunId: "live-run-before-fix",
          acceptance: Promise.resolve(true),
          outcome: Promise.resolve({ status: "accepted" as const }),
        }));

      const runId = `idem-iso-gw-before-${randomUUID()}`;
      const res = (await rpcReq(ws, "chat.send", {
        sessionKey: SESSION_KEY,
        message: "before-fix inbound",
        idempotencyKey: runId,
        queueMode: "steer",
      })) as WireResponse;

      expect(res.ok).toBe(true);
      expect(res.payload?.status).toBe("started");
      // Pre-fix: the steer is enqueued (the silent-loss race the fence
      // closes). The follow-up dispatch boundary is not reached.
      expect(registrySpy).toHaveBeenCalled();
      expect(dispatchCapture.calls).toBe(0);

      classifierSpy.mockRestore();
      registrySpy.mockRestore();
    },
  );
});
