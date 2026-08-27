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

const LOWERCASE_WORD_PATTERN = /^[a-z]+$/;

const PLAIN_WORD_PATTERN = /^[a-zA-Z]+$/;

const PLANNING_CONTINUATION_PATTERN =
  /^(?:then|next|after|afterwards|once|before|while|when|and|or|but|so|to|for|with|as|like|plus|also|unless|until|since|because|however|meanwhile|whereas)\b/i;

// A lowercase continuation that opens a fresh clause (copulas, auxiliaries,
// or the sentence adverb "now" before a finite verb — any word that is not a
// closed-class function word like "the"/"and"/"then") marks a glued prose
// boundary, e.g. "hooks.Targets are wired" or "suite.PinPoints now works.".
// Ordinary noun-phrase continuations ("foo.Bar results") keep the dotted
// reference glued so progress narration is never split into a fake
// deliverable.
const SENTENCE_OPENING_CONTINUATION_PATTERN =
  /^(?:am\b|is\b|are\b|was\b|were\b|be\b|been\b|being\b|has\b|have\b|had\b|do\b|does\b|did\b|will\b|would\b|shall\b|should\b|can\b|could\b|may\b|might\b|must\b|now\s+(?!(?:the|a|an|and|or|but|nor|so|to|for|with|as|at|by|from|of|in|on|into|onto|over|under|if|when|while|since|until|unless|because|although|though|that|this|these|those|there|here|it|i|you|he|she|we|they|them|his|her|its|our|your|their|not|no|only|just|still|yet|even|then|next|before|after|about|against|along|around|between|beyond|during|except|off|out|per|than|through|till|toward|towards|upon|via|within|without)\b)[a-z]+)/i;

function insertMissingSentenceSpaces(value: string): string {
  // A terminator glued to a Capitalized word is a sentence boundary unless
  // the dot belongs to a structured dotted reference (see helper below).
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
      if (isStructuredDottedToken(token, offset - start, value.slice(end))) {
        return match;
      }
    }
    return `${terminator} `;
  });
}

// Only lowercase-word.Prose splits ("hooks.Targets", "suite.PinPoints") when
// the continuation starts a new sentence; acronyms, camelCase, paths, known
// extensions and punctuated/planning/ordinary continuations stay glued so
// dotted references never fabricate a boundary.
function isStructuredDottedToken(token: string, dotIndex: number, continuation: string): boolean {
  const beforeDot = token.slice(0, dotIndex);
  const afterDot = token.slice(dotIndex + 1);
  if (
    KNOWN_FILE_EXTENSION_PATTERN.test(afterDot) ||
    /[/_-]/.test(token) ||
    token.split(".").length > 2 ||
    !LOWERCASE_WORD_PATTERN.test(beforeDot)
  ) {
    return true;
  }
  const rest = continuation.trimStart();
  if (rest.length === 0 || PLANNING_CONTINUATION_PATTERN.test(rest) || /^[,;)]/.test(rest)) {
    return true;
  }
  if (PLAIN_WORD_PATTERN.test(afterDot) && /^[a-z]/.test(rest)) {
    // Ordinary continuations belong to the dotted reference ("foo.Bar
    // results"); clause-opening continuations start a glued prose sentence
    // ("hooks.Targets are wired", "suite.PinPoints now has ...").
    return !SENTENCE_OPENING_CONTINUATION_PATTERN.test(rest);
  }
  return false;
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
