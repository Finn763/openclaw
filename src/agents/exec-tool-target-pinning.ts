import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import type { AnyAgentTool } from "./tools/common.js";

const EXEC_POLICY_PARAMETER_NAMES = new Set(["host", "security", "ask"]);
const NODE_EXEC_PARAMETER_NAMES = new Set(["command", "workdir", "env", "timeoutSeconds", "node"]);

type PinnedExecToolTarget = { host: "gateway" } | { host: "node"; node?: string };

/** Restricts an exec tool to one host target even when callers submit broader arguments. */
export function pinExecToolTarget(tool: AnyAgentTool, target: PinnedExecToolTarget): AnyAgentTool {
  const pinnedNode = target.host === "node" ? target.node?.trim() : undefined;
  return {
    ...tool,
    parameters: restrictExecToolParameters(tool.parameters, target.host, Boolean(pinnedNode)),
    execute: (toolCallId, args, signal, onUpdate) =>
      tool.execute(toolCallId, pinExecToolArgs(args, target, pinnedNode), signal, onUpdate),
  };
}

function pinExecToolArgs(
  args: unknown,
  target: PinnedExecToolTarget,
  pinnedNode: string | undefined,
): Record<string, unknown> {
  const source = asNonArrayRecord(args);
  const { host: _host, security: _security, ask: _ask, node: requestedNode, ...rest } = source;
  if (target.host === "gateway") {
    return { ...rest, host: "gateway" };
  }
  const nodeArgs = Object.fromEntries(
    Object.entries(rest).filter(([name]) => NODE_EXEC_PARAMETER_NAMES.has(name)),
  );
  const node = pinnedNode ?? (typeof requestedNode === "string" ? requestedNode.trim() : "");
  return {
    ...nodeArgs,
    host: "node",
    ...(node ? { node } : {}),
  };
}

function restrictExecToolParameters(
  parameters: AnyAgentTool["parameters"],
  host: PinnedExecToolTarget["host"],
  hasPinnedNode: boolean,
): AnyAgentTool["parameters"] {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return parameters;
  }
  // SAFETY: the guards above establish a non-array object schema before field inspection.
  const schema = parameters as Record<string, unknown>;
  const rawProperties = schema.properties;
  if (!rawProperties || typeof rawProperties !== "object" || Array.isArray(rawProperties)) {
    return parameters;
  }
  const includeParameter = (name: string) =>
    host === "node"
      ? NODE_EXEC_PARAMETER_NAMES.has(name) && !(hasPinnedNode && name === "node")
      : !EXEC_POLICY_PARAMETER_NAMES.has(name) && name !== "node";
  const properties = Object.fromEntries(
    Object.entries(rawProperties).filter(([name]) => includeParameter(name)),
  );
  const rawRequired = schema.required;
  const required = Array.isArray(rawRequired)
    ? rawRequired.filter((name) => typeof name !== "string" || includeParameter(name))
    : rawRequired;
  return {
    ...schema,
    properties,
    ...(Array.isArray(rawRequired) ? { required } : {}),
    // SAFETY: this preserves the original schema shape and only removes properties and required names.
  } as AnyAgentTool["parameters"];
}
