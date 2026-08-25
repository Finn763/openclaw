/**
 * Bounded nesting contract for parsed JSON/JSON5 values that feed config reads
 * and config-adjacent CLI inputs (secrets plans, patch/batch files).
 *
 * Parsing itself is stack-safe on the fast path (V8's JSON.parse and the json5
 * state machine are iterative), but the walks that follow it — $include
 * resolution, environment substitution, include-directive probing — recurse
 * over the structure. Without a depth contract, pathological deeply-nested
 * inputs exhaust the native stack (STATUS_STACK_OVERFLOW / 0xC00000FD on
 * Windows, where OpenClaw runs with an enlarged `--stack-size`), which no
 * JavaScript try/catch can observe, so the CLI dies without its error wrapper.
 *
 * Both guards here are themselves iterative, so measuring pathological input
 * can never overflow the stack.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Maximum supported structural nesting depth for parsed config/plan inputs. */
export const MAX_CONFIG_JSON_NESTING_DEPTH = 512;

/** Thrown when a raw or parsed JSON value nests deeper than the supported maximum. */
export class ConfigNestingDepthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigNestingDepthError";
  }
}

/** Formats a stable one-line violation message for CLI/snapshot surfaces. */
export function formatConfigNestingDepthMessage(label: string, depth: number): string {
  return `${label} exceeds the maximum supported nesting depth of ${MAX_CONFIG_JSON_NESTING_DEPTH} (measured ${depth} levels)`;
}

/**
 * Scans raw JSON/JSON5 text and returns the maximum bracket nesting depth.
 *
 * Iterative and string/comment-aware: string contents (single/double-quoted,
 * escaped quotes included) and JSON5 comments (line and block forms) are
 * skipped so bracket-like characters inside values or comments never skew the
 * count. Runs before any parser so a native parser overflow on deeply-nested
 * input can never happen.
 */
function measureRawJsonNestingDepth(raw: string): number {
  let depth = 0;
  let maxDepth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    // JSON5 comments are not structural: skip both forms so bracket-like
    // characters inside comments never skew the measured depth.
    if (char === "/" && raw[index + 1] === "/") {
      index += 2;
      while (index < raw.length && raw[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (char === "/" && raw[index + 1] === "*") {
      index += 2;
      while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) {
        index += 1;
      }
      if (index < raw.length) {
        index += 2;
      }
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      if (depth > maxDepth) {
        maxDepth = depth;
      }
    } else if (char === "}" || char === "]") {
      if (depth > 0) {
        depth -= 1;
      }
    }
    index += 1;
  }
  return maxDepth;
}

/**
 * Measures the maximum structural nesting depth of a parsed value.
 *
 * Iterative (explicit stack) so the measurement itself can never recurse.
 * Runs after parsing as a second layer: parsed values can also arrive from
 * in-process producers that never went through a raw-text boundary.
 */
function measureJsonNestingDepth(value: unknown): number {
  let maxDepth = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) {
      continue;
    }
    if (entry.depth > maxDepth) {
      maxDepth = entry.depth;
    }
    const current = entry.value;
    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push({ value: item, depth: entry.depth + 1 });
      }
    } else if (isRecord(current)) {
      for (const child of Object.values(current)) {
        stack.push({ value: child, depth: entry.depth + 1 });
      }
    }
  }
  return maxDepth;
}

/** Asserts raw JSON/JSON5 text stays within the supported nesting contract. */
export function assertBoundedRawJsonNesting(raw: string, label: string): void {
  const depth = measureRawJsonNestingDepth(raw);
  if (depth > MAX_CONFIG_JSON_NESTING_DEPTH) {
    throw new ConfigNestingDepthError(formatConfigNestingDepthMessage(label, depth));
  }
}

/** Asserts a parsed value stays within the supported nesting contract. */
export function assertBoundedJsonNesting(value: unknown, label: string): void {
  const depth = measureJsonNestingDepth(value);
  if (depth > MAX_CONFIG_JSON_NESTING_DEPTH) {
    throw new ConfigNestingDepthError(formatConfigNestingDepthMessage(label, depth));
  }
}

/**
 * Shared parser boundary for JSON/JSON5 inputs: asserts raw nesting before the
 * parser runs (so a native parser overflow can never happen) and re-asserts on
 * the parsed value (covering parsers or producers that arrive in-process).
 * Every config-adjacent parse site should go through this entry instead of
 * repeating the raw/parse/parsed triple.
 */
export function parseJsonWithNestingGuard(
  raw: string,
  label: string,
  parse: (text: string) => unknown,
): unknown {
  assertBoundedRawJsonNesting(raw, label);
  const parsed = parse(raw);
  assertBoundedJsonNesting(parsed, label);
  return parsed;
}
