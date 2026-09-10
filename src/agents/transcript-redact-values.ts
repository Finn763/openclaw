/**
 * Value-level transcript redaction helpers.
 *
 * These are the transcript write-side calls into logging redaction, so they are also
 * the only call sites that opt into redaction provenance: every mask they produce is
 * wrapped for replay, and replay rewrites only wrapped spans (#142821).
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLoggingConfig } from "../logging/config.js";
import { redactSourceInputTextWithConfig } from "../logging/redact-source.js";
import {
  redactModelVisibleSensitiveFieldValueWithConfig,
  redactModelVisibleToolPayloadTextWithConfig,
  redactSensitiveFieldValueWithConfig,
  redactToolPayloadTextWithConfig,
  withRedactionProvenance,
} from "../logging/redact.js";

function resolveTranscriptLoggingConfig(cfg?: OpenClawConfig) {
  const configuredLogging = readLoggingConfig();
  const redactPatterns = cfg?.logging?.redactPatterns ?? configuredLogging?.redactPatterns;
  return redactPatterns ? { redactPatterns } : undefined;
}

export function redactTranscriptText(
  value: string,
  cfg?: OpenClawConfig,
  modelVisibleToolResult = false,
): string {
  const loggingConfig = resolveTranscriptLoggingConfig(cfg);
  // Persisted masks carry explicit provenance so replay never has to guess (#142821).
  return withRedactionProvenance(() =>
    modelVisibleToolResult
      ? redactModelVisibleToolPayloadTextWithConfig(value, loggingConfig)
      : redactToolPayloadTextWithConfig(value, loggingConfig),
  );
}

export function redactTranscriptStructuredFieldValue(
  key: string,
  value: string,
  cfg?: OpenClawConfig,
  modelVisibleToolResult = false,
): string {
  // Preserve pagination state only in transcripts; value-pattern and global log redaction remain.
  return withRedactionProvenance(() =>
    /^(?:next[_-]?)?page[_-]?token$|^page[_-]?cursor$/i.test(key)
      ? redactTranscriptText(value, cfg, modelVisibleToolResult)
      : modelVisibleToolResult
        ? redactModelVisibleSensitiveFieldValueWithConfig(
            key,
            value,
            resolveTranscriptLoggingConfig(cfg),
          )
        : redactSensitiveFieldValueWithConfig(key, value, resolveTranscriptLoggingConfig(cfg)),
  );
}

/** Source input text is persisted too, so its masks need the same provenance. */
export function redactTranscriptSourceInputText(value: string, cfg?: OpenClawConfig): string {
  return withRedactionProvenance(() =>
    redactSourceInputTextWithConfig(value, resolveTranscriptLoggingConfig(cfg)),
  );
}
