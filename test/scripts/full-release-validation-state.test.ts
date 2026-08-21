import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  affectedActiveRunIds,
  buildReleaseExecutionPlan,
  buildReleaseExecutionPlanArtifact,
  buildReleaseStateArtifact,
  classifyReleaseSnapshot,
  formatReleaseStateOutcome,
  validateChildBinding,
  verifyReleaseStateArtifacts,
} from "../../scripts/full-release-validation-state.mjs";
import { waitForChildClose, waitForFile } from "../helpers/process-wait.js";

const SCRIPT = resolve("scripts/full-release-validation-state.mjs");
const SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);

function child(key: string, overrides: Record<string, unknown> = {}) {
  return {
    conclusion: "",
    dispatchName: `Dispatch ${key}`,
    displayTitle: key,
    errors: [],
    jobs: [],
    key,
    required: true,
    result: "success",
    runAttempt: 1,
    runId: "101",
    selected: true,
    source: "fresh",
    status: "in_progress",
    url: "https://example.invalid/runs/101",
    workflow: "ci.yml",
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return buildReleaseExecutionPlan({
    children: {
      normalCi: { result: "success", runAttempt: 1, runId: "101" },
      npmTelegram: { result: "success", runAttempt: 1, runId: "404" },
      pluginPrerelease: { result: "success", runAttempt: 1, runId: "202" },
      productPerformance: { result: "success", runAttempt: 1, runId: "505" },
      releaseChecks: { result: "success", runAttempt: 1, runId: "303" },
    },
    dockerPreflightResult: "success",
    evidenceReuse: false,
    parentRunAttempt: 2,
    parentRunId: "77",
    prepareCandidateResult: "success",
    rerunGroup: "all",
    resolveTargetResult: "success",
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
    ...overrides,
  });
}

function executionPlan(
  overrides: Record<string, unknown> = {},
  artifactOverrides: Record<string, unknown> = {},
) {
  const expected = {
    parentRunAttempt: 1,
    parentRunId: "77",
    targetSha: TARGET_SHA,
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
    ...((artifactOverrides.expected as Record<string, unknown> | undefined) ?? {}),
  };
  const built = plan({ ...overrides, parentRunAttempt: expected.parentRunAttempt });
  return buildReleaseExecutionPlanArtifact({
    children: built.children,
    expected,
    gates: built.gates,
    releaseProfile: "stable",
    rerunGroup: String(overrides.rerunGroup ?? "all"),
    ...artifactOverrides,
  });
}

describe("full release execution plan", () => {
  it("keeps required coverage selected when dispatch output is missing", () => {
    const result = plan({
      children: { normalCi: { result: "success", runAttempt: "", runId: "" } },
      rerunGroup: "ci",
    });
    expect(result.children.find((entry) => entry.key === "normalCi")).toMatchObject({
      required: true,
      runAttempt: null,
      runId: "",
      selected: true,
    });
    expect(
      classifyReleaseSnapshot({
        children: result.children.map((entry) => ({
          ...entry,
          errors: [],
          jobs: [],
          status: "missing",
        })),
        releaseProfile: "stable",
        workflowRef: "release-ci/tooling",
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ kind: "dispatch_missing" })],
      state: "blocked_complete",
    });
  });

  it.each(["install-smoke", "qa-parity", "qa-live"])(
    "does not require candidate preparation for focused %s",
    (rerunGroup) => {
      expect(
        plan({ prepareCandidateResult: "skipped", rerunGroup }).gates.find(
          (entry) => entry.name === "Prepare shared release candidate",
        ),
      ).toMatchObject({ required: false });
    },
  );

  it("does not prepare a candidate for published packages", () => {
    expect(
      plan({
        packageAcceptancePackageSpec: "openclaw@2026.8.4-beta.3",
        prepareCandidateResult: "skipped",
        rerunGroup: "package",
      }).gates.at(-1),
    ).toMatchObject({ required: false });
  });

  it("requires live-e2e candidate preparation only without a suite filter", () => {
    expect(plan({ rerunGroup: "live-e2e" }).gates.at(-1)).toMatchObject({ required: true });
    expect(plan({ liveSuiteFilter: "discord", rerunGroup: "live-e2e" }).gates.at(-1)).toMatchObject(
      {
        required: false,
      },
    );
  });
});

describe("release decision policy", () => {
  it("reports a decisive blocker while unrelated diagnostics continue", () => {
    const result = classifyReleaseSnapshot({
      children: [
        child("normalCi", {
          jobs: [{ conclusion: "failure", name: "test", status: "completed" }],
        }),
        child("releaseChecks", { runId: "202" }),
      ],
      releaseProfile: "stable",
      workflowRef: "main",
    });
    expect(result).toMatchObject({
      activeRunIds: ["101", "202"],
      state: "blocked_diagnostics_running",
    });
  });

  it("keeps advisory QA and beta performance failures non-blocking", () => {
    const result = classifyReleaseSnapshot({
      children: [
        child("releaseChecks", {
          conclusion: "failure",
          jobs: [
            {
              conclusion: "failure",
              name: "Run QA Lab runtime-pair lane (core)",
              status: "completed",
            },
            { conclusion: "success", name: "Verify release checks", status: "completed" },
          ],
          status: "completed",
        }),
        child("productPerformance", {
          conclusion: "failure",
          jobs: [{ conclusion: "failure", name: "benchmark", status: "completed" }],
          runId: "202",
          status: "completed",
        }),
      ],
      releaseProfile: "beta",
      workflowRef: "main",
    });
    expect(result).toMatchObject({ blockers: [], errors: [], state: "passed" });
  });

  it("preserves a blocker and an API error independently", () => {
    const result = classifyReleaseSnapshot({
      children: [
        child("normalCi", {
          jobs: [{ conclusion: "failure", name: "test", status: "completed" }],
        }),
        child("releaseChecks", {
          errors: [{ kind: "api_error", message: "HTTP 503", runId: "202" }],
          runId: "202",
          status: "unknown",
        }),
      ],
      releaseProfile: "stable",
      workflowRef: "main",
    });
    expect(result).toMatchObject({
      blockers: [expect.objectContaining({ job: "test" })],
      errors: [expect.objectContaining({ kind: "api_error" })],
      state: "orchestration_error",
    });
  });

  it("binds the exact child attempt and tooling tuple", () => {
    const result = validateChildBinding(
      child("normalCi"),
      {
        conclusion: "",
        created_at: "2026-08-21T00:00:00Z",
        display_title: "normalCi",
        event: "workflow_dispatch",
        head_branch: "release-ci/tooling",
        head_sha: SHA,
        html_url: "https://example.invalid/runs/101",
        id: 101,
        path: ".github/workflows/ci.yml@refs/heads/release-ci/tooling",
        run_attempt: 2,
        status: "in_progress",
        updated_at: "2026-08-21T00:01:00Z",
      },
      [],
    );
    expect(result.errors).toEqual([
      expect.objectContaining({
        kind: "provenance_mismatch",
        message: expect.stringContaining("attempt"),
      }),
    ]);
  });

  it("cancels only exact active affected children", () => {
    expect(
      affectedActiveRunIds(
        [
          child("normalCi"),
          child("releaseChecks", { runId: "202" }),
          child("npmTelegram", { runId: "303", status: "completed" }),
        ],
        [{ runId: "101" }, { runId: "303" }],
      ),
    ).toEqual(["101"]);
  });
});

describe("release state artifacts", () => {
  function artifact(mode: "decision" | "drain") {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const children = [
      child("normalCi", {
        conclusion: "success",
        createdAt: "2026-08-21T00:00:00Z",
        status: "completed",
        updatedAt: "2026-08-21T00:01:00Z",
      }),
    ];
    return buildReleaseStateArtifact({
      children,
      decision: { activeRunIds: [], blockers: [], errors: [], state: "passed" },
      executionPlan: sealedPlan,
      expected: {
        parentRunAttempt: 2,
        parentRunId: "77",
        targetSha: TARGET_SHA,
        workflowRef: "release-ci/tooling",
        workflowSha: SHA,
      },
      mode,
      releaseProfile: "stable",
      rerunGroup: "ci",
    });
  }

  it("uses one policy for decision, drain, and final verification", () => {
    expect(
      verifyReleaseStateArtifacts(
        executionPlan({ rerunGroup: "ci" }),
        artifact("decision"),
        artifact("drain"),
        {
          parentRunAttempt: 2,
          parentRunId: "77",
          releaseProfile: "stable",
          rerunGroup: "ci",
          targetSha: TARGET_SHA,
          workflowSha: SHA,
        },
      ),
    ).toMatchObject({ decision: { state: "passed" }, drain: { state: "passed" } });
  });

  it("uses state-specific operator guidance", () => {
    expect(
      formatReleaseStateOutcome({
        blockers: [{ conclusion: "failure", job: "test", url: "https://example.invalid/job" }],
        errors: [],
        state: "blocked_diagnostics_running",
      }),
    ).toContain("diagnose now, retry later");
    expect(
      formatReleaseStateOutcome({ blockers: [], errors: [], state: "blocked_complete" }),
    ).not.toContain("still collecting");
  });
});

describe("collector subprocess", () => {
  it("adopts the immutable attempt-one plan on an attempt-two collector retry", () => {
    const root = mkdtempSync(join(tmpdir(), "frv-plan-restore-"));
    const output = join(root, "full-release-execution-plan.json");
    const sealed = executionPlan({ rerunGroup: "ci" });
    writeFileSync(output, JSON.stringify(sealed));
    const result = spawnSync(process.execPath, [SCRIPT, "plan"], {
      env: {
        ...process.env,
        FULL_RELEASE_EXECUTION_PLAN_PATH: output,
        FULL_RELEASE_RESTORE_PLAN: "true",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "77",
        GITHUB_SHA: SHA,
        RELEASE_PROFILE: "stable",
        RERUN_GROUP: "ci",
        TARGET_SHA,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      parentRunAttempt: 1,
      sha256: sealed.sha256,
    });
  });

  it("writes the execution plan immediately when SIGTERM interrupts a stalled reuse API", async () => {
    const root = mkdtempSync(join(tmpdir(), "frv-plan-signal-"));
    const gh = join(root, "gh");
    const ghReady = join(root, "gh-ready");
    const output = join(root, "full-release-execution-plan.json");
    writeFileSync(gh, '#!/bin/sh\nprintf ready > "$FRV_GH_READY"\nsleep 30\n');
    chmodSync(gh, 0o755);
    const childProcess = spawn(process.execPath, [SCRIPT, "plan"], {
      env: {
        ...process.env,
        EVIDENCE_CHANGED_PATHS: "[]",
        FRV_GH_READY: ghReady,
        FULL_RELEASE_EXECUTION_PLAN_PATH: output,
        FULL_RELEASE_PLAN_INPUTS_JSON: JSON.stringify({
          children: { normalCi: { result: "skipped", runAttempt: "", runId: "" } },
          dockerPreflightResult: "skipped",
          evidenceChangedPaths: [],
          evidencePolicy: "exact-target-full-validation-v1",
          evidenceReuse: true,
          evidenceRootRunId: "99",
          evidenceRunUrl: "https://example.invalid/runs/99",
          evidenceSha: TARGET_SHA,
          parentRunAttempt: 1,
          parentRunId: "77",
          prepareCandidateResult: "skipped",
          rerunGroup: "ci",
          resolveTargetResult: "success",
          workflowRef: "release-ci/tooling",
          workflowSha: SHA,
        }),
        GITHUB_REF_NAME: "release-ci/tooling",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "77",
        GITHUB_SHA: SHA,
        PATH: `${root}:${process.env.PATH}`,
        RELEASE_PROFILE: "stable",
        RERUN_GROUP: "ci",
        TARGET_SHA,
      },
      stdio: "ignore",
    });
    await waitForFile(ghReady, 5_000);
    const exitPromise = waitForChildClose(childProcess);
    const started = Date.now();
    childProcess.kill("SIGTERM");
    await exitPromise;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      errors: [expect.objectContaining({ kind: "collector_cancelled" })],
      parentRunAttempt: 1,
    });
  });

  it("records target resolution failure even when no target SHA exists", () => {
    const root = mkdtempSync(join(tmpdir(), "frv-state-target-failure-"));
    const output = join(root, "decision.json");
    const executionPlanPath = join(root, "full-release-execution-plan.json");
    writeFileSync(
      executionPlanPath,
      JSON.stringify(
        executionPlan(
          {
            children: { normalCi: { result: "skipped", runAttempt: "", runId: "" } },
            dockerPreflightResult: "skipped",
            prepareCandidateResult: "skipped",
            rerunGroup: "ci",
            resolveTargetResult: "failure",
          },
          {
            expected: {
              parentRunAttempt: 1,
              parentRunId: "77",
              targetSha: "",
              workflowRef: "release-ci/tooling",
              workflowSha: SHA,
            },
          },
        ),
      ),
    );
    const result = spawnSync(process.execPath, [SCRIPT, "decision"], {
      env: {
        ...process.env,
        FAIL_FAST: "false",
        FULL_RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
        FULL_RELEASE_STATE_PATH: output,
        GITHUB_REF_NAME: "release-ci/tooling",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "77",
        GITHUB_SHA: SHA,
        RELEASE_PROFILE: "stable",
        RERUN_GROUP: "ci",
        TARGET_SHA: "",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(1);
    const artifact = JSON.parse(readFileSync(output, "utf8"));
    expect(artifact).toMatchObject({
      state: "blocked_complete",
      targetSha: "",
    });
    expect(artifact.blockers).toContainEqual(
      expect.objectContaining({
        kind: "parent_gate_failure",
        message: expect.stringContaining("Resolve target ref"),
      }),
    );
  });

  it("writes an immediate terminal handoff with active identity on SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "frv-state-signal-"));
    const gh = join(root, "gh");
    const ghReady = join(root, "gh-ready");
    const output = join(root, "drain.json");
    const executionPlanPath = join(root, "full-release-execution-plan.json");
    writeFileSync(
      executionPlanPath,
      JSON.stringify(
        executionPlan({
          children: { normalCi: { result: "success", runAttempt: 1, runId: "101" } },
          dockerPreflightResult: "skipped",
          prepareCandidateResult: "skipped",
          rerunGroup: "ci",
          resolveTargetResult: "success",
        }),
      ),
    );
    writeFileSync(
      gh,
      `#!/bin/sh
printf ready > "$FRV_GH_READY"
if [ "$1" = "api" ] && echo "$2" | grep -q '/jobs'; then
  exit 0
fi
printf '%s\\n' '{"id":101,"event":"workflow_dispatch","path":".github/workflows/ci.yml@refs/heads/release-ci/tooling","display_title":"CI full-release-validation-77-1-ci","head_branch":"release-ci/tooling","head_sha":"${SHA}","run_attempt":1,"status":"in_progress","conclusion":null,"created_at":"2026-08-21T00:00:00Z","updated_at":"2026-08-21T00:01:00Z","html_url":"https://example.invalid/runs/101"}'
`,
    );
    chmodSync(gh, 0o755);
    const childProcess = spawn(process.execPath, [SCRIPT, "drain"], {
      env: {
        ...process.env,
        FAIL_FAST: "false",
        FRV_GH_READY: ghReady,
        FULL_RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
        FULL_RELEASE_POLL_INTERVAL_MS: "60000",
        FULL_RELEASE_STATE_PATH: output,
        GITHUB_REF_NAME: "release-ci/tooling",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "77",
        GITHUB_SHA: SHA,
        PATH: `${root}:${process.env.PATH}`,
        RELEASE_PROFILE: "stable",
        RERUN_GROUP: "ci",
        TARGET_SHA: "b".repeat(40),
      },
      stdio: "ignore",
    });
    await waitForFile(ghReady, 5_000);
    const exitPromise = waitForChildClose(childProcess);
    childProcess.kill("SIGTERM");
    await exitPromise;
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      activeRunIds: ["101"],
      cancellation: { requested: true },
      state: "cancelled_with_children",
    });
  });

  it("cancels only the exact affected child and never cancels from drain", () => {
    const root = mkdtempSync(join(tmpdir(), "frv-state-fail-fast-"));
    const gh = join(root, "gh");
    const calls = join(root, "calls");
    writeFileSync(calls, "");
    writeFileSync(
      gh,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FRV_GH_CALLS"
if [ "$1" = "run" ] && [ "$2" = "cancel" ]; then
  exit 0
fi
case "$*" in
  *"/jobs?"*)
    case "$*" in
      *"/101/"*) printf '%s\\n' '{"name":"test","status":"completed","conclusion":"failure","html_url":"https://example.invalid/jobs/test"}' ;;
    esac
    exit 0
    ;;
esac
endpoint="$2"
[ "$endpoint" = "--paginate" ] && endpoint="$3"
run_id=$(printf '%s' "$endpoint" | sed 's#^.*/##')
title="CI full-release-validation-77-1-ci"
workflow="ci.yml"
case "$run_id" in
  202) title="Plugin Prerelease full-release-validation-77-1-plugin-prerelease"; workflow="plugin-prerelease.yml" ;;
  303) title="OpenClaw Release Checks full-release-validation-77-1-release-checks"; workflow="openclaw-release-checks.yml" ;;
  505) title="OpenClaw Performance full-release-validation-77-1"; workflow="openclaw-performance.yml" ;;
esac
status="completed"
[ "$run_id" = 101 ] && status="$FRV_FAILED_RUN_STATUS"
printf '{"id":%s,"event":"workflow_dispatch","path":".github/workflows/%s@refs/heads/release-ci/tooling","display_title":"%s","head_branch":"release-ci/tooling","head_sha":"${SHA}","run_attempt":1,"status":"%s","conclusion":"%s","created_at":"2026-08-21T00:00:00Z","updated_at":"2026-08-21T00:01:00Z","html_url":"https://example.invalid/runs/%s"}\\n' "$run_id" "$workflow" "$title" "$status" "$([ "$run_id" = 101 ] && echo failure || echo success)" "$run_id"
`,
    );
    chmodSync(gh, 0o755);
    const planInputs = {
      children: {
        normalCi: { result: "success", runAttempt: 1, runId: "101" },
        pluginPrerelease: { result: "success", runAttempt: 1, runId: "202" },
        productPerformance: { result: "success", runAttempt: 1, runId: "505" },
        releaseChecks: { result: "success", runAttempt: 1, runId: "303" },
      },
      dockerPreflightResult: "success",
      evidenceReuse: false,
      parentRunAttempt: 2,
      parentRunId: "77",
      prepareCandidateResult: "success",
      rerunGroup: "all",
      resolveTargetResult: "success",
      workflowRef: "release-ci/tooling",
      workflowSha: SHA,
    };
    const executionPlanPath = join(root, "full-release-execution-plan.json");
    writeFileSync(
      executionPlanPath,
      JSON.stringify(
        executionPlan(planInputs, {
          expected: {
            parentRunAttempt: 1,
            parentRunId: "77",
            targetSha: TARGET_SHA,
            workflowRef: "release-ci/tooling",
            workflowSha: SHA,
          },
        }),
      ),
    );
    const baseEnv = {
      ...process.env,
      FRV_GH_CALLS: calls,
      FULL_RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
      GITHUB_REF_NAME: "release-ci/tooling",
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "77",
      GITHUB_SHA: SHA,
      PATH: `${root}:${process.env.PATH}`,
      RELEASE_PROFILE: "stable",
      RERUN_GROUP: "all",
      TARGET_SHA: "b".repeat(40),
    };
    const decision = spawnSync(process.execPath, [SCRIPT, "decision"], {
      env: {
        ...baseEnv,
        FAIL_FAST: "true",
        FRV_FAILED_RUN_STATUS: "in_progress",
        FULL_RELEASE_STATE_PATH: join(root, "decision.json"),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(decision.signal, decision.stderr).toBeNull();
    const afterDecision = readFileSync(calls, "utf8");
    expect(afterDecision).toContain("run cancel 101");
    expect(afterDecision).not.toContain("run cancel 202");
    writeFileSync(calls, "");
    const drain = spawnSync(process.execPath, [SCRIPT, "drain"], {
      env: {
        ...baseEnv,
        FAIL_FAST: "false",
        FRV_FAILED_RUN_STATUS: "completed",
        FULL_RELEASE_STATE_PATH: join(root, "drain.json"),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(drain.signal, drain.stderr).toBeNull();
    expect(readFileSync(calls, "utf8")).not.toContain("run cancel");
  });
});
