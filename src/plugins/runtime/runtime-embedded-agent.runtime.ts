/** Lazy runtime adapter for plugin-owned embedded-agent execution. */
import { randomUUID } from "node:crypto";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import { runEmbeddedAgent as runEmbeddedAgentCore } from "../../agents/embedded-agent.js";
import { getRuntimeConfig } from "../../config/config.js";
import { recordPluginRuntimeActionDecision } from "../runtime-action-decision.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import type { PluginRuntime } from "./types.js";

export const runPluginEmbeddedAgent: PluginRuntime["agent"]["runEmbeddedAgent"] = async (
  params,
) => {
  const runtimeScope = getPluginRuntimeGatewayRequestScope();
  const pluginId = runtimeScope?.pluginId;
  if (!pluginId) {
    throw new Error("Plugin embedded-agent execution requires an active plugin runtime scope.");
  }
  if ("admittedRunContext" in params || "preparedRunAdmission" in params) {
    throw new Error("Plugin embedded-agent execution cannot supply host run authority.");
  }
  params.abortSignal?.throwIfAborted();
  const decisionOccurrenceId = randomUUID();
  let executionIdentityToken: AdmittedRunContext["executionIdentityToken"];
  const preparedRunAdmission = prepareAgentRunAdmission({
    cfg: params.config ?? getRuntimeConfig(),
    operationalRunInstance: createOperationalRunInstanceRef(params.runId),
    facts: {
      runId: params.runId,
      agentId: params.sessionTarget?.agentId ?? params.agentId ?? "main",
      ingress: {
        kind: "plugin",
        boundary: "plugin-runtime",
        rawSourceRef: pluginId,
        state: "present",
      },
    },
    onAdmitted: (context) => {
      const token = context.executionIdentityToken;
      executionIdentityToken = token;
      recordPluginRuntimeActionDecision({
        token,
        family: "plugin",
        operation: "run",
        outcome: "allowed",
        coverageState: "enforced",
        reasonCode: "plugin_runtime_owner_admitted",
        owner: "plugin-runtime",
        decisionBoundary: "plugin.runtime.run-embedded-agent",
        policyRefs: ["plugin:registered-owner", "run:admission"],
        summary: "The registered plugin owner passed exact run admission.",
        remediation: [],
        discriminator: JSON.stringify([pluginId, params.runId, decisionOccurrenceId, "admission"]),
      });
      if (runtimeScope?.nativeActionEvidence === "unsupported") {
        recordPluginRuntimeActionDecision({
          token,
          family: "native-runtime",
          operation: "action-evidence",
          outcome: "not-applicable",
          coverageState: "unsupported",
          reasonCode: "native_action_callback_unsupported",
          owner: "plugin-runtime",
          decisionBoundary: "plugin.runtime.external-native-action",
          policyRefs: ["native-action:explicit-callback"],
          summary:
            "This external runtime exposes no OpenClaw pre-action callback; this coverage fact does not claim a side effect occurred.",
          missingEvidence: ["native.action_callback"],
          remediation: [
            {
              code: "add_native_action_adapter",
              text: "Add an OpenClaw adapter callback before the native runtime performs the side effect.",
            },
          ],
          discriminator: JSON.stringify([
            pluginId,
            params.runId,
            decisionOccurrenceId,
            "unsupported-native-action",
          ]),
        });
      }
    },
  });
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      preparedRunAdmission.close();
    }
  };
  // Abort owns authority revocation independently of core completion; the
  // post-registration check closes the prepare-to-listener race.
  params.abortSignal?.addEventListener("abort", close, { once: true });
  try {
    params.abortSignal?.throwIfAborted();
    const result = await runEmbeddedAgentCore({ ...params, preparedRunAdmission });
    recordPluginRuntimeActionDecision({
      token: executionIdentityToken,
      family: "plugin",
      operation: "run",
      outcome: "allowed",
      coverageState: "attribution-only",
      reasonCode: "plugin_runtime_completed",
      owner: "plugin-runtime",
      decisionBoundary: "plugin.runtime.run-embedded-agent",
      summary: "The plugin-owned runtime completed; this is attribution, not authorization.",
      remediation: [],
      discriminator: JSON.stringify([pluginId, params.runId, decisionOccurrenceId, "completion"]),
    });
    return result;
  } finally {
    params.abortSignal?.removeEventListener("abort", close);
    close();
  }
};
