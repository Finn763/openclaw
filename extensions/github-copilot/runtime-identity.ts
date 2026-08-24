import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildCopilotIdeHeaders } from "openclaw/plugin-sdk/provider-auth";

// GitHub's current fine-grained PAT contract is the Copilot CLI identity.
// Keep this provider-owned instead of changing the legacy public SDK constant.
export const COPILOT_RUNTIME_INTEGRATION_ID = "copilot-developer-cli";

// Integration ids are slug-shaped vendor values; fail closed on anything else
// so a config typo can never ship a header with CR/LF or whitespace.
const COPILOT_INTEGRATION_ID_SLUG = /^[a-z0-9._-]{1,64}$/i;

// Warn once per distinct invalid configured value so a typo in the escape
// hatch surfaces a diagnostic instead of silently becoming the default.
const warnedInvalidIntegrationIds = new Set<string>();

// Render a non-string configured value for diagnostics without relying on
// Object's default stringification; mirrors the core allowed-values renderer.
function safeStringify(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall back to string coercion when value is not JSON-serializable.
  }
  // Deliberate last-resort renderer; the assertion opts into String()
  // semantics for non-JSON values without changing runtime behavior.
  return String(value as string | number | boolean | bigint | symbol | null);
}

/**
 * Resolve the Copilot-Integration-Id this provider sends. `*.ghe.com`
 * data-residency tenants authorize only the `vscode-chat` identity, so the
 * header is overridable via
 * `models.providers.github-copilot.params.integrationId`; unset values fall
 * back to the public default silently, while every present invalid value
 * (empty string, non-slug string, or non-string type) falls back with a
 * one-time warning per distinct value.
 */
export function resolveGithubCopilotIntegrationId(params?: { config?: OpenClawConfig }): string {
  const providerParams = params?.config?.models?.providers?.["github-copilot"]?.params;
  const raw: unknown =
    providerParams && typeof providerParams === "object" ? providerParams.integrationId : undefined;
  if (raw !== undefined) {
    const value = typeof raw === "string" ? raw.trim() : undefined;
    if (value && COPILOT_INTEGRATION_ID_SLUG.test(value)) {
      return value;
    }
    const display = value === undefined ? safeStringify(raw) : JSON.stringify(value);
    if (!warnedInvalidIntegrationIds.has(display)) {
      warnedInvalidIntegrationIds.add(display);
      console.warn(
        `[openclaw] github-copilot: ignoring invalid params.integrationId ${display}; using ${COPILOT_RUNTIME_INTEGRATION_ID}`,
      );
    }
  }
  return COPILOT_RUNTIME_INTEGRATION_ID;
}

/** Build the static request identity shared by Copilot inference transports. */
export function buildCopilotRuntimeHeaders(params?: {
  integrationId?: string;
}): Record<string, string> {
  return {
    ...buildCopilotIdeHeaders(),
    "Copilot-Integration-Id": params?.integrationId ?? COPILOT_RUNTIME_INTEGRATION_ID,
    "Openai-Organization": "github-copilot",
  };
}
