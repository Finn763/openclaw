export const RELEASE_DECISION_STATES: readonly string[];
export function buildReleaseExecutionPlan(input: Record<string, any>): {
  children: Array<Record<string, any>>;
  gates: Array<Record<string, any>>;
};
export function buildReleaseExecutionPlanArtifact(input: Record<string, any>): Record<string, any>;
export function validateReleaseExecutionPlanArtifact(
  payload: unknown,
  expected?: Record<string, unknown>,
): Record<string, any>;
export function releaseExecutionPlanSha256(plan: Record<string, any>): string;

export function isReleaseCheckJobAdvisory(input: {
  jobName: string;
  releaseProfile: string;
  workflowRef: string;
}): boolean;

export function failedJobsForPolicy(
  child: Record<string, any>,
  releaseProfile: string,
  workflowRef: string,
): Array<Record<string, any>>;

export function terminalPolicyPass(
  child: Record<string, any>,
  releaseProfile: string,
  workflowRef: string,
): boolean;

export function classifyReleaseSnapshot(input: Record<string, any>): Record<string, any>;
export function buildReleaseStateArtifact(input: Record<string, any>): Record<string, any>;
export function validateReleaseStateArtifact(
  payload: unknown,
  expected?: Record<string, unknown>,
  expectedMode?: string,
): Record<string, any>;
export function verifyReleaseStateArtifacts(
  executionPlanPayload: unknown,
  decisionPayload: unknown,
  drainPayload: unknown,
  expected?: Record<string, unknown>,
): {
  decision: Record<string, any>;
  drain: Record<string, any>;
  executionPlan: Record<string, any>;
};
export function releaseStateDetailLines(payload: Record<string, any>, maxItems?: number): string[];
export function formatReleaseStateOutcome(payload: Record<string, any>): string;
export function affectedActiveRunIds(
  children: Array<Record<string, any>>,
  blockers: Array<Record<string, any>>,
  cancelledRunIds?: Set<string>,
): string[];
