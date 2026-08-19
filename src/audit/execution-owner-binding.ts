import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import { parseExecutionIdentityAdmissionToken } from "./execution-identity-admission.js";

export type ExecutionOwnerBindingResult =
  | "disabled"
  | "bound"
  | "already-bound"
  | "mismatch"
  | "missing";

type ExecutionOwnerBinding = Readonly<{
  contextId: string;
  executionId: string;
}>;

/** Extracts only an admitted exact identity; operational run correlation cannot bind owner rows. */
export function executionOwnerBindingFromAdmission(
  admitted: AdmittedRunContext,
): ExecutionOwnerBinding | undefined {
  if (!admitted.executionIdentityToken) {
    return undefined;
  }
  const token = parseExecutionIdentityAdmissionToken(admitted.executionIdentityToken);
  if (token.runId !== admitted.operationalRunInstance.runId) {
    throw new Error("owner execution binding disagrees with the admitted run");
  }
  return { contextId: token.contextId, executionId: token.executionId };
}

export function classifyExecutionOwnerBinding(
  current: { contextId: string | null; executionId: string | null },
  binding: ExecutionOwnerBinding,
): Exclude<ExecutionOwnerBindingResult, "disabled" | "bound" | "missing"> | "unbound" {
  if (current.contextId === null && current.executionId === null) {
    return "unbound";
  }
  return current.contextId === binding.contextId && current.executionId === binding.executionId
    ? "already-bound"
    : "mismatch";
}

/** Carries immutable admission forward; owner I/O begins only after execution starts. */
export function createPostAdmissionExecutionOwnerBinding(
  bind: (context: AdmittedRunContext) => void,
): {
  onAdmitted: (context: AdmittedRunContext) => void;
  onExecutionStarted: () => void;
} {
  let admitted: AdmittedRunContext | undefined;
  let bound = false;
  return {
    onAdmitted: (context) => {
      admitted = context;
    },
    onExecutionStarted: () => {
      if (bound || !admitted) {
        return;
      }
      bound = true;
      bind(admitted);
    },
  };
}
