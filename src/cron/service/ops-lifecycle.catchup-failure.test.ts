// Startup catch-up must not strand the periodic scheduler when persisted
// storage fails mid-recovery (e.g. disk full during restart catch-up writes).
import { describe, expect, it, vi } from "vitest";
import * as stateDb from "../../state/openclaw-state-db.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import type { CronJob } from "../types.js";
import { start, stop } from "./ops-lifecycle.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-startup-catchup-failure-",
});

function createDueSystemEventJob(now: number): CronJob {
  return {
    id: "missed-system-event",
    name: "missed system event",
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "missed tick" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: now - 1 },
  };
}

describe("cron startup with failing catch-up", () => {
  it("arms the periodic timer even when startup catch-up storage fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();
    await writeCronStoreSnapshot({ storePath, jobs: [createDueSystemEventJob(now)] });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const storageFailure = vi
      .spyOn(stateDb, "runOpenClawStateWriteTransaction")
      .mockImplementation(() => {
        throw new Error("disk full");
      });

    try {
      await start(state);
      expect(state.timer).not.toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.stringContaining("disk full") }),
        expect.stringContaining("catch-up"),
      );
    } finally {
      storageFailure.mockRestore();
      stop(state);
    }
  });
});
