import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatMonitorPlan } from "./heartbeat-monitor.js";
import type { CronJob, CronJobCreate } from "./types.js";

function monitorJob(input: CronJobCreate, id = `job-${input.agentId}`): CronJob {
  return {
    ...input,
    id,
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {},
  } as CronJob;
}

describe("heartbeat monitor desired-state planning", () => {
  it("creates no monitor jobs for an ownerless explicit multi-agent roster", () => {
    const cfg = {
      agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
    } as OpenClawConfig;

    expect(resolveHeartbeatMonitorPlan(cfg, [], { schedulerSeed: "test-seed" }).specs).toEqual([]);
  });

  it("plans changed monitors once without adopting colliding user jobs", () => {
    const cfg = {
      agents: {
        defaults: { heartbeat: { every: "15m" } },
        list: [{ id: "main" }, { id: "ops" }, { id: "new" }],
      },
    } as OpenClawConfig;
    const options = { schedulerSeed: "test-seed" };
    const initial = resolveHeartbeatMonitorPlan(cfg, [], options).specs;
    const main = initial.find((spec) => spec.agentId === "main");
    const ops = initial.find((spec) => spec.agentId === "ops");
    if (!main || !ops) {
      throw new Error("expected configured heartbeat monitor specs");
    }
    const jobs = [
      monitorJob(main.input),
      monitorJob({ ...ops.input, enabled: false }),
      monitorJob({ ...main.input, agentId: "stale", declarationKey: "heartbeat:stale" }),
      monitorJob({
        ...main.input,
        agentId: "collider",
        declarationKey: "heartbeat:collider",
        payload: { kind: "systemEvent", text: "user-owned" },
      }),
    ];

    const plan = resolveHeartbeatMonitorPlan(cfg, jobs, options);

    expect(plan.changes.map(({ kind, agentId }) => ({ kind, agentId }))).toEqual([
      { kind: "update", agentId: "ops" },
      { kind: "create", agentId: "new" },
      { kind: "remove", agentId: "stale" },
    ]);
  });

  it("removes the retained monitor when the cadence is disabled (#141558)", () => {
    const cfg = {
      agents: { defaults: { heartbeat: { every: "0m" } } },
    } as OpenClawConfig;
    const options = { schedulerSeed: "test-seed" };
    const existing = monitorJob({
      declarationKey: "heartbeat:main",
      displayName: "Heartbeat (main)",
      name: "heartbeat-main",
      agentId: "main",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
      payload: { kind: "heartbeat" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    });

    const plan = resolveHeartbeatMonitorPlan(cfg, [existing], options);

    expect(plan.specs).toEqual([]);
    expect(plan.changes).toEqual([{ kind: "remove", agentId: "main", job: existing }]);
  });

  it("removes duplicate monitors before updating the retained row", () => {
    const cfg = {
      agents: { defaults: { heartbeat: { every: "15m" } } },
    } as OpenClawConfig;
    const options = { schedulerSeed: "test-seed" };
    const input = resolveHeartbeatMonitorPlan(cfg, [], options).specs[0]?.input;
    if (!input) {
      throw new Error("expected configured heartbeat monitor spec");
    }
    const older = { ...monitorJob(input, "older"), updatedAtMs: 1 };
    const newer = {
      ...monitorJob({ ...input, enabled: false }, "newer"),
      updatedAtMs: 2,
    };

    const plan = resolveHeartbeatMonitorPlan(cfg, [older, newer], options);

    expect(plan.changes).toEqual([
      { kind: "remove", agentId: "main", job: older },
      expect.objectContaining({ kind: "update", agentId: "main" }),
    ]);
  });

  it("owns no monitor row when the cadence is explicitly disabled (#141558)", () => {
    const cfg = {
      agents: {
        defaults: { heartbeat: { every: "0m" } },
        list: [
          { id: "main", heartbeat: { every: "0m" } },
          { id: "ops", heartbeat: { every: "0m" } },
        ],
      },
    } as OpenClawConfig;
    const plan = resolveHeartbeatMonitorPlan(cfg, [], { schedulerSeed: "test-seed" });

    expect(plan.specs).toEqual([]);
    expect(plan.changes).toEqual([]);
  });

  it("removes stale monitors when the cadence is explicitly disabled (#141558)", () => {
    const enabledCfg = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops" }],
      },
    } as OpenClawConfig;
    const options = { schedulerSeed: "test-seed" };
    const enabled = resolveHeartbeatMonitorPlan(enabledCfg, [], options).specs;
    if (enabled.length !== 2) {
      throw new Error("expected enabled heartbeat monitor specs");
    }
    const existing = enabled.map((spec) => monitorJob({ ...spec.input, enabled: true }));
    const disabledCfg = {
      agents: {
        defaults: { heartbeat: { every: "0m" } },
        list: [
          { id: "main", heartbeat: { every: "0m" } },
          { id: "ops", heartbeat: { every: "0m" } },
        ],
      },
    } as OpenClawConfig;

    const plan = resolveHeartbeatMonitorPlan(disabledCfg, existing, options);

    expect(plan.specs).toEqual([]);
    expect(plan.changes.map(({ kind, agentId }) => ({ kind, agentId }))).toEqual([
      { kind: "remove", agentId: "main" },
      { kind: "remove", agentId: "ops" },
    ]);
  });

  it.each([
    { field: "name", value: "stale-name", changes: ["update"] },
    { field: "agentId", value: "stale-agent", changes: ["update"] },
    { field: "sessionTarget", value: "isolated", changes: ["update"] },
    { field: "wakeMode", value: "now", changes: ["update"] },
    { field: "declarationKey", value: "heartbeat:stale", changes: ["create", "remove"] },
  ] as const)("repairs a monitor with drifted $field", ({ field, value, changes }) => {
    const cfg = {
      agents: { defaults: { heartbeat: { every: "15m" } } },
    } as OpenClawConfig;
    const options = { schedulerSeed: "test-seed" };
    const input = resolveHeartbeatMonitorPlan(cfg, [], options).specs[0]?.input;
    if (!input) {
      throw new Error("expected configured heartbeat monitor spec");
    }

    const plan = resolveHeartbeatMonitorPlan(
      cfg,
      [monitorJob({ ...input, [field]: value })],
      options,
    );

    expect(plan.changes.map((change) => change.kind)).toEqual(changes);
  });
});
