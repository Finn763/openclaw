import { createHash } from "node:crypto";

const SUCCESSFUL_JOB_CONCLUSIONS = new Set(["neutral", "skipped", "success"]);
const MAX_REPORTED_ISSUES = 25;
const MAX_SUMMARY_ISSUES = 5;
const MAX_LABEL_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 500;
const MAX_URL_LENGTH = 1024;

export const RELEASE_DECISION_STATES = Object.freeze([
  "qualifying",
  "blocked_diagnostics_running",
  "passed",
  "blocked_complete",
  "orchestration_error",
  "cancelled_with_children",
]);

const RELEASE_DECISION_STATE_SET = new Set(RELEASE_DECISION_STATES);
const CHILD_SPECS = Object.freeze([
  {
    dispatchName: "Dispatch CI",
    displayName: "CI",
    key: "normalCi",
    rerunGroups: ["all", "ci"],
    suffix: "-ci",
    workflow: "ci.yml",
  },
  {
    dispatchName: "Dispatch plugin prerelease",
    displayName: "Plugin Prerelease",
    key: "pluginPrerelease",
    rerunGroups: ["all", "plugin-prerelease"],
    suffix: "-plugin-prerelease",
    workflow: "plugin-prerelease.yml",
  },
  {
    dispatchName: "Dispatch release checks",
    displayName: "OpenClaw Release Checks",
    key: "releaseChecks",
    rerunGroups: [
      "all",
      "install-smoke",
      "cross-os",
      "live-e2e",
      "package",
      "qa-parity",
      "qa-live",
    ],
    suffix: "-release-checks",
    workflow: "openclaw-release-checks.yml",
  },
  {
    dispatchName: "Dispatch npm Telegram E2E",
    displayName: "NPM Telegram Beta E2E",
    key: "npmTelegram",
    rerunGroups: ["npm-telegram"],
    suffix: "-npm-telegram",
    workflow: "npm-telegram-beta-e2e.yml",
  },
  {
    dispatchName: "Dispatch OpenClaw Performance",
    displayName: "OpenClaw Performance",
    key: "productPerformance",
    rerunGroups: ["all", "performance"],
    suffix: "",
    workflow: "openclaw-performance.yml",
  },
]);

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function boundedString(value, maxLength) {
  return stringValue(value)
    .replaceAll(/[\r\n\t]+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function positiveInteger(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : undefined;
}

function booleanValue(value) {
  return value === true || value === "true";
}

function candidatePreparationRequired(input) {
  if (
    booleanValue(input.evidenceReuse) ||
    stringValue(input.releasePackageSpec).trim() ||
    stringValue(input.packageAcceptancePackageSpec).trim()
  ) {
    return false;
  }
  if (["all", "plugin-prerelease", "cross-os", "package"].includes(input.rerunGroup)) {
    return true;
  }
  return input.rerunGroup === "live-e2e" && !stringValue(input.liveSuiteFilter).trim();
}

export function buildReleaseExecutionPlan(input) {
  const parentRunId = stringValue(input.parentRunId).trim();
  const parentRunAttempt = positiveInteger(input.parentRunAttempt);
  const rerunGroup = stringValue(input.rerunGroup).trim();
  if (!parentRunId || parentRunAttempt === undefined || !rerunGroup) {
    throw new Error("release execution plan identity is invalid");
  }
  const reused = booleanValue(input.evidenceReuse);
  const childInputs =
    input.children && typeof input.children === "object" && !Array.isArray(input.children)
      ? input.children
      : {};
  const npmTelegramForAll =
    rerunGroup === "all" &&
    Boolean(
      stringValue(input.npmTelegramPackageSpec).trim() ||
      stringValue(input.releasePackageSpec).trim(),
    );
  const children = CHILD_SPECS.map((spec) => {
    const raw = childInputs[spec.key] ?? {};
    const required =
      spec.key === "npmTelegram"
        ? rerunGroup === "npm-telegram" || npmTelegramForAll
        : spec.rerunGroups.includes(rerunGroup);
    const dispatchId = `full-release-validation-${parentRunId}-${parentRunAttempt}${spec.suffix}`;
    return {
      dispatchName: spec.dispatchName,
      displayTitle: `${spec.displayName} ${dispatchId}`,
      key: spec.key,
      required,
      result: stringValue(raw.result, "skipped"),
      runAttempt: positiveInteger(raw.runAttempt) ?? null,
      runId: stringValue(raw.runId).trim(),
      selected: required,
      source: reused ? "reused" : "fresh",
      url: stringValue(raw.url).trim(),
      workflow: spec.workflow,
      workflowRef: stringValue(input.workflowRef).trim(),
      workflowSha: stringValue(input.workflowSha).trim(),
    };
  });
  const gates = [
    {
      name: "Resolve target ref",
      required: true,
      result: stringValue(input.resolveTargetResult, "missing"),
    },
    {
      name: "Verify Docker runtime image assets",
      required: !reused && rerunGroup === "all",
      result: stringValue(input.dockerPreflightResult, "skipped"),
    },
    {
      name: "Prepare shared release candidate",
      required: candidatePreparationRequired(input),
      result: stringValue(input.prepareCandidateResult, "skipped"),
    },
  ];
  return { children, gates };
}

function normalizedGate(gate) {
  return {
    name: boundedString(gate?.name, MAX_LABEL_LENGTH),
    required: gate?.required === true,
    result: boundedString(gate?.result, MAX_LABEL_LENGTH),
  };
}

function normalizedEvidenceReuse(evidenceReuse) {
  if (!evidenceReuse || evidenceReuse.requested !== true) {
    return { requested: false };
  }
  return {
    changedPaths: Array.isArray(evidenceReuse.changedPaths)
      ? evidenceReuse.changedPaths
          .map((value) => boundedString(value, MAX_LABEL_LENGTH))
          .filter(Boolean)
      : [],
    evidenceSha: boundedString(evidenceReuse.evidenceSha, MAX_LABEL_LENGTH),
    policy: boundedString(evidenceReuse.policy, MAX_LABEL_LENGTH),
    requested: true,
    rootRunId: boundedString(evidenceReuse.rootRunId, MAX_LABEL_LENGTH),
    runUrl: boundedString(evidenceReuse.runUrl, MAX_URL_LENGTH),
  };
}

function executionPlanDigestPayload(plan) {
  return {
    blockers: plan.blockers,
    children: plan.children,
    errors: plan.errors,
    evidenceReuse: plan.evidenceReuse,
    gates: plan.gates,
    kind: plan.kind,
    parentRunAttempt: plan.parentRunAttempt,
    parentRunId: plan.parentRunId,
    releaseProfile: plan.releaseProfile,
    rerunGroup: plan.rerunGroup,
    targetSha: plan.targetSha,
    version: plan.version,
    workflowRef: plan.workflowRef,
    workflowSha: plan.workflowSha,
  };
}

export function releaseExecutionPlanSha256(plan) {
  return createHash("sha256")
    .update(JSON.stringify(executionPlanDigestPayload(plan)))
    .digest("hex");
}

export function buildReleaseExecutionPlanArtifact({
  blockers = [],
  children,
  errors = [],
  evidenceReuse,
  expected,
  gates,
  releaseProfile,
  rerunGroup,
}) {
  const plan = {
    version: 1,
    kind: "openclaw.full-release-execution-plan",
    parentRunId: String(expected.parentRunId),
    parentRunAttempt: positiveInteger(expected.parentRunAttempt),
    workflowRef: boundedString(expected.workflowRef, MAX_LABEL_LENGTH),
    workflowSha: boundedString(expected.workflowSha, MAX_LABEL_LENGTH),
    targetSha: boundedString(expected.targetSha, MAX_LABEL_LENGTH),
    releaseProfile: boundedString(releaseProfile, MAX_LABEL_LENGTH),
    rerunGroup: boundedString(rerunGroup, MAX_LABEL_LENGTH),
    evidenceReuse: normalizedEvidenceReuse(evidenceReuse),
    gates: gates.map(normalizedGate),
    children: children.map(normalizedPlanChild),
    blockers: normalizeIssues(blockers, "release_blocker"),
    errors: normalizeIssues(errors, "orchestration_error"),
  };
  return { ...plan, sha256: releaseExecutionPlanSha256(plan) };
}

export function validateReleaseExecutionPlanArtifact(payload, expected = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("release execution plan artifact is invalid");
  }
  if (
    payload.version !== 1 ||
    payload.kind !== "openclaw.full-release-execution-plan" ||
    !/^[1-9][0-9]*$/u.test(String(payload.parentRunId ?? "")) ||
    positiveInteger(payload.parentRunAttempt) === undefined ||
    !/^[a-f0-9]{40}$/u.test(String(payload.workflowSha ?? "")) ||
    (payload.targetSha !== "" && !/^[a-f0-9]{40}$/u.test(String(payload.targetSha ?? ""))) ||
    (expected.parentRunId !== undefined &&
      String(payload.parentRunId) !== String(expected.parentRunId)) ||
    (expected.workflowRef !== undefined && payload.workflowRef !== expected.workflowRef) ||
    (expected.workflowSha !== undefined && payload.workflowSha !== expected.workflowSha) ||
    (expected.releaseProfile !== undefined && payload.releaseProfile !== expected.releaseProfile) ||
    (expected.rerunGroup !== undefined && payload.rerunGroup !== expected.rerunGroup) ||
    (expected.targetSha !== undefined && payload.targetSha !== expected.targetSha)
  ) {
    throw new Error("release execution plan artifact binding is invalid");
  }
  const plan = {
    ...payload,
    parentRunAttempt: positiveInteger(payload.parentRunAttempt),
    parentRunId: String(payload.parentRunId),
    children: validatePlan(payload.children),
    blockers: normalizeIssues(payload.blockers, "release_blocker"),
    errors: normalizeIssues(payload.errors, "orchestration_error"),
    evidenceReuse: normalizedEvidenceReuse(payload.evidenceReuse),
    gates: Array.isArray(payload.gates) ? payload.gates.map(normalizedGate) : [],
  };
  const sha256 = releaseExecutionPlanSha256(plan);
  if (payload.sha256 !== sha256) {
    throw new Error("release execution plan artifact digest is invalid");
  }
  return { ...plan, sha256 };
}

function normalizeIssue(issue, fallbackKind) {
  return {
    child: boundedString(issue?.child, MAX_LABEL_LENGTH),
    conclusion: boundedString(issue?.conclusion, MAX_LABEL_LENGTH),
    job: boundedString(issue?.job, MAX_LABEL_LENGTH),
    kind: boundedString(issue?.kind, MAX_LABEL_LENGTH) || fallbackKind,
    message: boundedString(issue?.message, MAX_MESSAGE_LENGTH),
    runId: boundedString(issue?.runId, MAX_LABEL_LENGTH),
    url: boundedString(issue?.url, MAX_URL_LENGTH),
  };
}

function normalizeIssues(issues, fallbackKind) {
  return (Array.isArray(issues) ? issues : [])
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => normalizeIssue(issue, fallbackKind));
}

export function isReleaseCheckJobAdvisory({ jobName, releaseProfile, workflowRef }) {
  if (
    jobName.startsWith("Run QA Lab parity lane (") ||
    jobName === "Run QA Lab parity report" ||
    jobName.startsWith("Run QA Lab runtime-pair lane (") ||
    jobName === "Verify QA Lab runtime-pair lanes" ||
    jobName === "Run QA Lab live Discord lane" ||
    jobName === "Run QA Lab live WhatsApp lane" ||
    jobName === "Run QA Lab live Slack lane"
  ) {
    return true;
  }
  if (/^tideclaw\/alpha\/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}Z$/u.test(workflowRef)) {
    return !(
      jobName === "resolve_target" ||
      jobName === "Prepare release package artifact" ||
      jobName.startsWith("install_smoke_release_checks / ") ||
      jobName === "Run package acceptance" ||
      jobName.startsWith("Run package acceptance / ")
    );
  }
  return (
    releaseProfile === "beta" &&
    (jobName.startsWith("Run package acceptance / Telegram package acceptance / ") ||
      (jobName.startsWith("Run repo/live E2E validation / ") &&
        (jobName.includes("Docker live") ||
          jobName.includes("Live media suites") ||
          jobName.includes("validate_live_provider_suites") ||
          jobName.includes("validate_release_live_cache") ||
          jobName.includes("prepare_live_test_image"))))
  );
}

export function failedJobsForPolicy(child, releaseProfile, workflowRef) {
  return child.jobs.filter((job) => {
    if (
      job.status !== "completed" ||
      SUCCESSFUL_JOB_CONCLUSIONS.has(String(job.conclusion ?? ""))
    ) {
      return false;
    }
    if (child.key === "releaseChecks") {
      return !isReleaseCheckJobAdvisory({
        jobName: stringValue(job.name),
        releaseProfile,
        workflowRef,
      });
    }
    return !(child.key === "productPerformance" && releaseProfile === "beta");
  });
}

export function terminalPolicyPass(child, releaseProfile, workflowRef) {
  if (child.status !== "completed") {
    return false;
  }
  if (child.conclusion === "success") {
    return true;
  }
  if (child.key === "productPerformance" && releaseProfile === "beta") {
    return true;
  }
  if (child.key === "releaseChecks") {
    const verifier = child.jobs.find((job) => job.name === "Verify release checks");
    return (
      verifier?.status === "completed" &&
      verifier.conclusion === "success" &&
      failedJobsForPolicy(child, releaseProfile, workflowRef).length === 0
    );
  }
  return false;
}

function dispatchMissingBlockers(children) {
  return children
    .filter(
      (child) =>
        child.required &&
        child.selected &&
        (!/^[1-9][0-9]*$/u.test(String(child.runId ?? "")) ||
          positiveInteger(child.runAttempt) === undefined),
    )
    .map((child) => ({
      child: child.key,
      conclusion: stringValue(child.result, "missing"),
      job: child.dispatchName || `Dispatch ${child.key}`,
      kind: "dispatch_missing",
      message: `${child.key} required dispatch did not record an exact run ID and attempt`,
      runId: stringValue(child.runId),
      url: stringValue(child.url),
    }));
}

function dispatchResultBlockers(children) {
  return children
    .filter(
      (child) =>
        child.required && child.selected && child.source === "fresh" && child.result !== "success",
    )
    .map((child) => ({
      child: child.key,
      conclusion: stringValue(child.result, "missing"),
      job: child.dispatchName || `Dispatch ${child.key}`,
      kind: "dispatch_failed",
      message: `${child.key} required dispatch ended with ${stringValue(child.result, "missing")}`,
      runId: stringValue(child.runId),
      url: stringValue(child.url),
    }));
}

export function classifyReleaseSnapshot({
  cancelled = false,
  children,
  extraBlockers = [],
  extraErrors = [],
  localFailures = [],
  releaseProfile,
  workflowRef,
}) {
  const selected = children.filter((child) => child.selected);
  const active = selected.filter(
    (child) => child.runId && child.runAttempt && child.status !== "completed",
  );
  const childErrors = selected.flatMap((child) =>
    (child.errors ?? []).filter((error) => error.kind !== "dispatch_missing"),
  );
  const childJobBlockers = selected.flatMap((child) =>
    failedJobsForPolicy(child, releaseProfile, workflowRef).map((job) => ({
      child: child.key,
      conclusion: job.conclusion,
      job: job.name,
      kind: "job_failure",
      message: `${child.key} job failed policy`,
      runId: child.runId,
      url: job.html_url ?? job.url ?? child.url,
    })),
  );
  const childJobBlockerKeys = new Set(
    childJobBlockers.map((blocker) => `${blocker.child}:${blocker.runId}`),
  );
  const terminalBlockers = selected
    .filter(
      (child) =>
        child.runId &&
        child.runAttempt &&
        child.status === "completed" &&
        !terminalPolicyPass(child, releaseProfile, workflowRef) &&
        !childJobBlockerKeys.has(`${child.key}:${child.runId}`),
    )
    .map((child) => ({
      child: child.key,
      conclusion: child.conclusion,
      job: "<workflow>",
      kind: "workflow_failure",
      message: `${child.key} workflow failed release policy`,
      runId: child.runId,
      url: child.url,
    }));
  const blockers = normalizeIssues(
    [
      ...localFailures,
      ...extraBlockers,
      ...dispatchMissingBlockers(selected),
      ...dispatchResultBlockers(selected),
      ...childJobBlockers,
      ...terminalBlockers,
    ],
    "release_blocker",
  );
  const errors = normalizeIssues([...extraErrors, ...childErrors], "orchestration_error");

  let state;
  if (cancelled && active.length > 0) {
    state = "cancelled_with_children";
  } else if (errors.length > 0) {
    state = "orchestration_error";
  } else if (blockers.length > 0) {
    state = active.length > 0 ? "blocked_diagnostics_running" : "blocked_complete";
  } else if (active.length > 0) {
    state = "qualifying";
  } else {
    state = "passed";
  }

  return {
    activeRunIds: active.map((child) => String(child.runId)),
    blockers,
    errors,
    state,
  };
}

function childTiming(child) {
  const started = Date.parse(child.createdAt);
  const updated = Date.parse(child.updatedAt);
  return {
    durationMinutes:
      Number.isFinite(started) && Number.isFinite(updated)
        ? Math.round(((updated - started) / 60_000) * 10) / 10
        : null,
    jobs: child.jobs.map((job) => {
      const jobStarted = Date.parse(job.started_at);
      const jobCompleted = Date.parse(job.completed_at);
      return {
        conclusion: stringValue(job.conclusion),
        durationMinutes:
          Number.isFinite(jobStarted) && Number.isFinite(jobCompleted)
            ? Math.round(((jobCompleted - jobStarted) / 60_000) * 10) / 10
            : null,
        name: boundedString(job.name, MAX_LABEL_LENGTH),
        startedAt: stringValue(job.started_at),
        status: stringValue(job.status),
        url: boundedString(job.html_url ?? job.url, MAX_URL_LENGTH),
      };
    }),
  };
}

function normalizedPlanChild(child) {
  return {
    dispatchName: boundedString(child.dispatchName, MAX_LABEL_LENGTH),
    displayTitle: boundedString(child.displayTitle, MAX_LABEL_LENGTH),
    key: boundedString(child.key, MAX_LABEL_LENGTH),
    required: child.required === true,
    result: boundedString(child.result, MAX_LABEL_LENGTH),
    runAttempt: positiveInteger(child.runAttempt) ?? null,
    runId: boundedString(child.runId, MAX_LABEL_LENGTH),
    selected: child.selected === true,
    source: child.source === "reused" ? "reused" : "fresh",
    url: boundedString(child.url, MAX_URL_LENGTH),
    workflow: boundedString(child.workflow, MAX_LABEL_LENGTH),
    workflowRef: boundedString(child.workflowRef, MAX_LABEL_LENGTH),
    workflowSha: boundedString(child.workflowSha, MAX_LABEL_LENGTH),
  };
}

export function buildReleaseStateArtifact({
  cancellation = {},
  children,
  decision,
  executionPlan,
  expected,
  mode,
  releaseProfile,
  rerunGroup,
}) {
  return {
    version: 2,
    kind:
      mode === "decision"
        ? "openclaw.full-release-decision"
        : "openclaw.full-release-diagnostic-drain",
    mode,
    parentRunId: expected.parentRunId,
    parentRunAttempt: expected.parentRunAttempt,
    sourceParentRunAttempt: executionPlan.parentRunAttempt,
    workflowRef: expected.workflowRef,
    workflowSha: expected.workflowSha,
    targetSha: expected.targetSha,
    releaseProfile,
    rerunGroup,
    executionPlanSha256: executionPlan.sha256,
    state: decision.state,
    activeRunIds: decision.activeRunIds,
    blockers: decision.blockers,
    errors: decision.errors,
    cancellation: {
      cancelledRunIds: [...(cancellation.cancelledRunIds ?? [])].map(String),
      requested: cancellation.requested === true,
    },
    children: Object.fromEntries(
      children
        .filter((child) => child.selected && child.runId && child.runAttempt)
        .map((child) => [
          child.key,
          {
            conclusion: stringValue(child.conclusion),
            displayTitle: boundedString(child.displayTitle, MAX_LABEL_LENGTH),
            errors: normalizeIssues(child.errors, "orchestration_error"),
            runAttempt: positiveInteger(child.runAttempt),
            runId: String(child.runId),
            status: stringValue(child.status),
            timing: childTiming(child),
            url: boundedString(child.url, MAX_URL_LENGTH),
            workflow: boundedString(child.workflow, MAX_LABEL_LENGTH),
            workflowRef: boundedString(child.workflowRef, MAX_LABEL_LENGTH),
            workflowSha: boundedString(child.workflowSha, MAX_LABEL_LENGTH),
          },
        ]),
    ),
  };
}

function validatePlan(value) {
  if (!Array.isArray(value)) {
    throw new Error("release state plan is invalid");
  }
  const keys = new Set();
  return value.map((child) => {
    const normalized = normalizedPlanChild(child);
    if (
      !normalized.key ||
      !normalized.workflow ||
      !normalized.displayTitle ||
      !normalized.dispatchName ||
      keys.has(normalized.key) ||
      (normalized.required && !normalized.selected)
    ) {
      throw new Error("release state child plan is invalid");
    }
    keys.add(normalized.key);
    return normalized;
  });
}

export function validateReleaseStateArtifact(payload, expected = {}, expectedMode) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("release state artifact is invalid");
  }
  const mode = expectedMode ?? payload.mode;
  const expectedKind =
    mode === "decision"
      ? "openclaw.full-release-decision"
      : "openclaw.full-release-diagnostic-drain";
  if (
    payload.version !== 2 ||
    payload.mode !== mode ||
    payload.kind !== expectedKind ||
    !RELEASE_DECISION_STATE_SET.has(stringValue(payload.state)) ||
    !/^[a-f0-9]{64}$/u.test(String(payload.executionPlanSha256 ?? "")) ||
    positiveInteger(payload.sourceParentRunAttempt) === undefined ||
    (expected.parentRunId !== undefined &&
      String(payload.parentRunId) !== String(expected.parentRunId)) ||
    (expected.parentRunAttempt !== undefined &&
      Number(payload.parentRunAttempt) !== Number(expected.parentRunAttempt)) ||
    (expected.workflowSha !== undefined && payload.workflowSha !== expected.workflowSha) ||
    (expected.targetSha !== undefined && payload.targetSha !== expected.targetSha) ||
    (expected.releaseProfile !== undefined && payload.releaseProfile !== expected.releaseProfile) ||
    (expected.rerunGroup !== undefined && payload.rerunGroup !== expected.rerunGroup)
  ) {
    throw new Error("release state artifact binding is invalid");
  }
  const blockers = normalizeIssues(payload.blockers, "release_blocker");
  const errors = normalizeIssues(payload.errors, "orchestration_error");
  const activeRunIds = Array.isArray(payload.activeRunIds)
    ? payload.activeRunIds.map(String).filter((runId) => /^[1-9][0-9]*$/u.test(runId))
    : [];
  return {
    ...payload,
    activeRunIds,
    blockers,
    errors,
    sourceParentRunAttempt: positiveInteger(payload.sourceParentRunAttempt),
  };
}

export function verifyReleaseStateArtifacts(
  executionPlanPayload,
  decisionPayload,
  drainPayload,
  expected = {},
) {
  const executionPlan = validateReleaseExecutionPlanArtifact(executionPlanPayload, expected);
  const decision = validateReleaseStateArtifact(decisionPayload, expected, "decision");
  const drain = validateReleaseStateArtifact(drainPayload, expected, "drain");
  if (
    decision.executionPlanSha256 !== executionPlan.sha256 ||
    drain.executionPlanSha256 !== executionPlan.sha256 ||
    decision.sourceParentRunAttempt !== executionPlan.parentRunAttempt ||
    drain.sourceParentRunAttempt !== executionPlan.parentRunAttempt
  ) {
    throw new Error("release decision and diagnostic drain execution plans differ");
  }
  if (
    decision.state !== "passed" ||
    drain.state !== "passed" ||
    decision.blockers.length > 0 ||
    decision.errors.length > 0 ||
    drain.blockers.length > 0 ||
    drain.errors.length > 0
  ) {
    throw new Error(
      `release state artifacts are not green: decision=${decision.state} drain=${drain.state}`,
    );
  }
  for (const child of executionPlan.children.filter((entry) => entry.selected)) {
    if (!child.runId || !child.runAttempt) {
      throw new Error(`selected release child omitted exact identity: ${child.key}`);
    }
    const snapshot = drain.children?.[child.key];
    if (
      !snapshot ||
      String(snapshot.runId) !== child.runId ||
      Number(snapshot.runAttempt) !== child.runAttempt ||
      snapshot.status !== "completed"
    ) {
      throw new Error(`diagnostic drain child is not terminal and exact: ${child.key}`);
    }
  }
  return { decision, drain, executionPlan };
}

function issueSummary(prefix, issue) {
  const label =
    issue.job || issue.message || issue.child || issue.kind || `${prefix.toLowerCase()} detail`;
  const result = issue.conclusion ? ` (${issue.conclusion})` : "";
  const url = issue.url ? ` ${issue.url}` : "";
  return `- ${prefix}: ${label}${result}${url}`;
}

export function releaseStateDetailLines(payload, maxItems = MAX_SUMMARY_ISSUES) {
  const normalizedMax = Math.max(1, Math.min(Number(maxItems) || MAX_SUMMARY_ISSUES, 10));
  const lines = [];
  for (const blocker of payload.blockers.slice(0, normalizedMax)) {
    lines.push(issueSummary("Blocker", blocker));
  }
  for (const error of payload.errors.slice(0, normalizedMax)) {
    lines.push(issueSummary("Collector error", error));
  }
  const omitted =
    Math.max(0, payload.blockers.length - normalizedMax) +
    Math.max(0, payload.errors.length - normalizedMax);
  if (omitted > 0) {
    lines.push(`- ${omitted} additional blocker/error item(s) omitted`);
  }
  return lines;
}

export function formatReleaseStateOutcome(payload) {
  const lines = [`Full Release Validation state: ${payload.state}`];
  lines.push(...releaseStateDetailLines(payload));
  if (payload.state === "blocked_diagnostics_running") {
    lines.push(
      "Diagnostic Drain is still collecting terminal evidence; diagnose now, retry later.",
    );
  } else if (payload.state === "orchestration_error") {
    lines.push("Recover the collector against the same exact child runs; do not redispatch tests.");
  } else if (payload.state === "cancelled_with_children") {
    lines.push("The collector stopped while exact child runs remained active.");
  }
  return lines.join("\n");
}

export function affectedActiveRunIds(children, blockers, cancelledRunIds = new Set()) {
  const affected = new Set(
    blockers.map((blocker) => String(blocker.runId ?? "")).filter((runId) => runId),
  );
  return children
    .filter(
      (child) =>
        child.status !== "completed" &&
        affected.has(String(child.runId)) &&
        !cancelledRunIds.has(String(child.runId)),
    )
    .map((child) => String(child.runId));
}
