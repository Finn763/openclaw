/**
 * Shared grammar for explicit redaction provenance in persisted text (#142821).
 *
 * A mask (`***`, or `first6…last4` from logging redaction) is ordinary-looking text:
 * once it is stored, no reader can tell "the producer redacted this secret" from
 * "the user typed these exact bytes". Persistence therefore wraps every mask it
 * produces in these markers, and replay may only rewrite marked spans. Unmarked
 * text is literal history and must be left alone — guessing from string shape
 * rewrites prose ellipses, markdown rules, and assignment prefixes.
 */

/** Opens a persisted mask. */
export const REDACTION_PROVENANCE_START = "\u27E6openclaw:redacted\u27E7";
/** Closes a persisted mask. */
export const REDACTION_PROVENANCE_END = "\u27E6/openclaw:redacted\u27E7";

/** Returns whether text carries at least one provenance opener. */
export function hasRedactionProvenance(text: string): boolean {
  return text.includes(REDACTION_PROVENANCE_START);
}

/** Wraps one freshly produced mask. Inputs that are already marked pass through. */
export function markRedactionProvenance(mask: string): string {
  if (hasRedactionProvenance(mask)) {
    return mask;
  }
  return `${REDACTION_PROVENANCE_START}${mask}${REDACTION_PROVENANCE_END}`;
}

/**
 * Replaces every complete marked span with `replacement`, keeping all surrounding
 * text byte-identical. An unterminated opener is left verbatim: a reader that
 * cannot see the end of a mask must not invent one.
 */
export function replaceRedactionProvenance(text: string, replacement: string): string {
  if (!hasRedactionProvenance(text)) {
    return text;
  }
  let result = "";
  let cursor = 0;
  for (;;) {
    const open = text.indexOf(REDACTION_PROVENANCE_START, cursor);
    if (open < 0) {
      break;
    }
    const close = text.indexOf(REDACTION_PROVENANCE_END, open + REDACTION_PROVENANCE_START.length);
    if (close < 0) {
      break;
    }
    result += text.slice(cursor, open) + replacement;
    cursor = close + REDACTION_PROVENANCE_END.length;
  }
  return result + text.slice(cursor);
}
