/**
 * Byte-limit helpers for session tool stderr/stdout tails.
 *
 * Tail storage is byte-bounded but decoded as UTF-8, so truncation avoids
 * splitting multi-byte characters in display output.
 */
import { Buffer } from "node:buffer";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf8Suffix } from "../../../utils/utf8-truncate.js";

/** Normalizes optional positive numeric limits to a finite integer. */
export function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  return resolveIntegerOption(value, fallback, { min: 1 });
}

/** Default stderr tail retained for long-running session tools. */
export const SESSION_TOOL_STDERR_TAIL_BYTES = 64 * 1024;

/** Result of a bounded tail append, including the discarded head byte count. */
export interface BoundedTextTailAppendResult {
  /** UTF-8-safe tail retained within the byte cap. */
  tail: string;
  /** Bytes of earlier output discarded from the head by this append. */
  droppedBytes: number;
}

/**
 * Appends a chunk while retaining only the UTF-8-safe tail within maxBytes,
 * and reports how many bytes of earlier output were discarded from the head.
 */
export function appendBoundedTextTailTracked(
  current: string,
  chunk: string,
  maxBytes = SESSION_TOOL_STDERR_TAIL_BYTES,
): BoundedTextTailAppendResult {
  const effectiveMaxBytes = normalizePositiveLimit(maxBytes, SESSION_TOOL_STDERR_TAIL_BYTES);
  const combined = `${current}${chunk}`;
  const tail = truncateUtf8Suffix(combined, effectiveMaxBytes);
  return {
    tail,
    droppedBytes: Math.max(
      0,
      Buffer.byteLength(combined, "utf8") - Buffer.byteLength(tail, "utf8"),
    ),
  };
}

/** Appends a chunk while retaining only the UTF-8-safe tail within maxBytes. */
export function appendBoundedTextTail(
  current: string,
  chunk: string,
  maxBytes = SESSION_TOOL_STDERR_TAIL_BYTES,
): string {
  return appendBoundedTextTailTracked(current, chunk, maxBytes).tail;
}
