// Defines task terminal outcome contracts used by completion handling.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { TaskTerminalOutcome } from "./task-registry.types.js";

/** Terminal fields required when a mandatory detached task completion is invalid. */
export type RequiredCompletionTerminalResult = {
  terminalOutcome?: Extract<TaskTerminalOutcome, "blocked">;
  terminalSummary?: string;
};

const PROGRESS_ONLY_PATTERN =
  /^(?:i(?:'|\u2019)ll|i will|i(?:'|\u2019)m|i am|i(?:'|\u2019)m going to|i am going to|let me|i need to)\s+(?:now\s+)?(?:analyz(?:e|ing)|apply|check(?:ing)?|continue|debug(?:ging)?|follow(?:ing)?\s+up|inspect(?:ing)?|investigat(?:e|ing)|look(?:ing)?(?:\s+into)?|map(?:ping)?|open(?:ing)?|read(?:ing)?|report(?:ing)?(?:\s+back)?|review(?:ing)?|run(?:ning)?|start(?:ing)?|test(?:ing)?|trace|trac(?:e|ing)|try(?:ing)?|update|verify(?:ing)?|work(?:ing)?)/i;

const BARE_PROGRESS_ONLY_PATTERN =
  /^(?:analyz(?:e|ing)|check(?:ing)?|debug(?:ging)?|inspect(?:ing)?|investigat(?:e|ing)|look(?:ing)?\s+into|map(?:ping)?|read(?:ing)?|report(?:ing)?\s+back|review(?:ing)?|run(?:ning)?|test(?:ing)?|trac(?:e|ing)|verify(?:ing)?|work(?:ing)?\s+on)\b/i;

const FOLLOW_UP_PLANNING_PREFIX_PATTERN =
  /^(?:after(?:wards|\s+that)?|from\s+there|next|once\s+(?:done|that(?:'|\u2019)?s\s+done|that\s+is\s+done)|then)[,.\s]+/i;

function normalizeCompletionText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizeCompletionFailureReason(value: string | null | undefined): string {
  const normalized = normalizeCompletionText(value);
  if (!normalized) {
    return "";
  }
  return normalized.length <= 160 ? normalized : `${truncateUtf16Safe(normalized, 159)}...`;
}

function matchesProgressOnlyPrefix(value: string): boolean {
  if (PROGRESS_ONLY_PATTERN.test(value) || BARE_PROGRESS_ONLY_PATTERN.test(value)) {
    return true;
  }
  const followup = value.replace(FOLLOW_UP_PLANNING_PREFIX_PATTERN, "").trim();
  return (
    followup !== value &&
    (PROGRESS_ONLY_PATTERN.test(followup) || BARE_PROGRESS_ONLY_PATTERN.test(followup))
  );
}

const KNOWN_FILE_EXTENSION_PATTERN =
  /^(?:Kt|py|js|ts|json|yaml|toml|sh|mjs|cjs|go|rs|java|cs|h|cpp)(?![A-Za-z0-9_])/;

const DOTTED_IDENTIFIER_TOKEN_PATTERN = /^[A-Za-z0-9_./-]+$/;

function insertMissingSentenceSpaces(value: string): string {
  // Glued sentence boundaries ("done.Next...") get the missing space so the
  // boundary below can find them; dotted references (`API.Client`, `main.Kt`)
  // and colons are structured tokens and are left untouched.
  return value.replace(/([.!?])(?=[A-Z])/g, (match, terminator, offset) => {
    const charBeforeDot = offset > 0 ? value[offset - 1] : undefined;
    if (terminator === "." && charBeforeDot !== undefined && /[A-Za-z0-9_]/.test(charBeforeDot)) {
      let start = offset;
      while (start > 0 && !/\s/.test(value[start - 1]!)) {
        start -= 1;
      }
      let end = offset + 1;
      while (end < value.length && !/\s/.test(value[end]!)) {
        end += 1;
      }
      const token = value.slice(start, end);
      const afterDot = token.slice(offset - start + 1);
      if (
        DOTTED_IDENTIFIER_TOKEN_PATTERN.test(token) ||
        KNOWN_FILE_EXTENSION_PATTERN.test(afterDot)
      ) {
        return match;
      }
    }
    return `${terminator} `;
  });
}

function hasNonProgressFollowupSentence(value: string): boolean {
  const spaced = insertMissingSentenceSpaces(value);
  const boundary = /(?:[.!?:]|\s[-\u2013\u2014])\s+\S/.exec(spaced);
  if (!boundary) {
    return false;
  }
  const separatorEnd = boundary.index + boundary[0].length - 1;
  const firstSentence = spaced.slice(0, separatorEnd).trim();
  const rest = spaced.slice(separatorEnd).trim();
  return matchesProgressOnlyPrefix(firstSentence) && !isProgressOnlyCompletionText(rest);
}

function isProgressOnlyCompletionText(value: string | null | undefined): boolean {
  const normalized = normalizeCompletionText(value);
  if (!normalized) {
    return false;
  }
  if (hasNonProgressFollowupSentence(normalized)) {
    return false;
  }
  return matchesProgressOnlyPrefix(normalized);
}

export function resolveRequiredCompletionTerminalResult(
  resultText: string | null | undefined,
): RequiredCompletionTerminalResult {
  const normalized = normalizeCompletionText(resultText);
  if (!normalized) {
    return {
      terminalOutcome: "blocked",
      terminalSummary: "Required completion did not produce a final deliverable.",
    };
  }
  if (isProgressOnlyCompletionText(normalized)) {
    return {
      terminalOutcome: "blocked",
      terminalSummary:
        "Required completion ended with progress-only text, not a final deliverable.",
    };
  }
  return {};
}

export function resolveRequiredCompletionDeliveryFailureTerminalResult(
  reason: string | null | undefined,
): RequiredCompletionTerminalResult {
  const normalizedReason = normalizeCompletionFailureReason(reason);
  return {
    terminalOutcome: "blocked",
    terminalSummary: normalizedReason
      ? `Required completion delivery failed before reaching the requester: ${normalizedReason}.`
      : "Required completion delivery failed before reaching the requester.",
  };
}
