import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import { readEmbeddedMessageDeliveryFact } from "../../embedded-agent-message-delivery.js";
/**
 * Detects message-tool-only sends that delivered a visible source reply.
 */
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  resolveMessageToolSourceReplyFinal,
} from "../../embedded-agent-message-tool-source-reply.js";
import type { AfterToolCallContext, AfterToolCallResult, Agent } from "../../runtime/index.js";
import { readToolResultDetails } from "../../tool-result-error.js";

function argsRecordForToolCall(context: AfterToolCallContext): Record<string, unknown> {
  if (context.args && typeof context.args === "object" && !Array.isArray(context.args)) {
    return context.args as Record<string, unknown>;
  }
  const fallbackArgs = context.toolCall.arguments;
  return fallbackArgs && typeof fallbackArgs === "object" && !Array.isArray(fallbackArgs)
    ? fallbackArgs
    : {};
}

/** A completed source reply ends the turn only for message-tool-only delivery
 * or the internal UI sink; external current-source receipts remain nonterminal. */
function isTerminalMessageToolSourceReply(params: {
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  context: AfterToolCallContext;
  hookResult?: AfterToolCallResult;
}): boolean {
  const resultDetails = readToolResultDetails(params.context.result);
  const deliveryFact = readEmbeddedMessageDeliveryFact(resultDetails?.messageDelivery);
  const isError = params.hookResult?.isError ?? params.context.isError;
  const delivered = isDeliveredMessageToolOnlySourceReplyResult({
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    toolName: params.context.toolCall.name,
    args: argsRecordForToolCall(params.context),
    result: params.context.result,
    hookResult: params.hookResult,
    isError,
    ...(deliveryFact
      ? {
          deliveryConfirmed:
            deliveryFact.status === "settled" && (!isError || deliveryFact.partialDelivery),
        }
      : {}),
  });
  return (
    delivered &&
    (params.sourceReplyDeliveryMode === "message_tool_only" ||
      resultDetails?.sourceReplySink === "internal-ui" ||
      readToolResultDetails(params.hookResult)?.sourceReplySink === "internal-ui")
  );
}

/** Installs an after-tool hook that records and settles completed source replies. */
export function installMessageToolTerminalHook(params: {
  agent: Agent;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  onDeliveredSourceReply?: () => void;
}): void {
  const previousAfterToolCall = params.agent.afterToolCall?.bind(params.agent);
  params.agent.afterToolCall = async (context, signal) => {
    const hookResult = await previousAfterToolCall?.(context, signal);
    if (
      isTerminalMessageToolSourceReply({
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        context,
        hookResult,
      })
    ) {
      params.onDeliveredSourceReply?.();
      if (resolveMessageToolSourceReplyFinal(argsRecordForToolCall(context))) {
        return { ...hookResult, terminate: true };
      }
    }
    return hookResult;
  };
}
