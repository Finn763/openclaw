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

/**
 * Resolve the Copilot-Integration-Id this provider sends. `*.ghe.com`
 * data-residency tenants authorize only the `vscode-chat` identity, so the
 * header is overridable via
 * `models.providers.github-copilot.params.integrationId`; unset or malformed
 * values fall back to the public default (malformed ones with a warning).
 */
export function resolveGithubCopilotIntegrationId(params?: { config?: OpenClawConfig }): string {
  const providerParams = params?.config?.models?.providers?.["github-copilot"]?.params;
  const raw =
    providerParams && typeof providerParams === "object" ? providerParams.integrationId : undefined;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value && COPILOT_INTEGRATION_ID_SLUG.test(value)) {
    return value;
  }
  if (value && !warnedInvalidIntegrationIds.has(value)) {
    warnedInvalidIntegrationIds.add(value);
    console.warn(
      `[openclaw] github-copilot: ignoring invalid params.integrationId ${JSON.stringify(value)}; using ${COPILOT_RUNTIME_INTEGRATION_ID}`,
    );
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
