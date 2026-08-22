// Github Copilot tests cover runtime identity plugin behavior.
import { describe, expect, it } from "vitest";
import {
  COPILOT_RUNTIME_INTEGRATION_ID,
  buildCopilotRuntimeHeaders,
  resolveGithubCopilotIntegrationId,
} from "./runtime-identity.js";

function configWithIntegrationId(value: unknown) {
  return {
    models: {
      providers: {
        "github-copilot": { params: { integrationId: value } },
      },
    },
  } as never;
}

describe("resolveGithubCopilotIntegrationId", () => {
  it("defaults to the Copilot CLI identity when nothing is configured", () => {
    expect(resolveGithubCopilotIntegrationId()).toBe(COPILOT_RUNTIME_INTEGRATION_ID);
    expect(resolveGithubCopilotIntegrationId({ config: {} as never })).toBe(
      COPILOT_RUNTIME_INTEGRATION_ID,
    );
  });

  it("honors the configured integrationId so GHE data-residency tenants can send vscode-chat", () => {
    expect(
      resolveGithubCopilotIntegrationId({ config: configWithIntegrationId("vscode-chat") }),
    ).toBe("vscode-chat");
  });

  it("fails closed on malformed or non-string values so no header injection ships", () => {
    expect(
      resolveGithubCopilotIntegrationId({ config: configWithIntegrationId("vscode chat") }),
    ).toBe(COPILOT_RUNTIME_INTEGRATION_ID);
    expect(
      resolveGithubCopilotIntegrationId({ config: configWithIntegrationId("bad\r\nX-Evil: 1") }),
    ).toBe(COPILOT_RUNTIME_INTEGRATION_ID);
    expect(resolveGithubCopilotIntegrationId({ config: configWithIntegrationId(42) })).toBe(
      COPILOT_RUNTIME_INTEGRATION_ID,
    );
    expect(resolveGithubCopilotIntegrationId({ config: configWithIntegrationId("") })).toBe(
      COPILOT_RUNTIME_INTEGRATION_ID,
    );
  });
});

describe("buildCopilotRuntimeHeaders", () => {
  it("carries the default identity without a resolved override", () => {
    expect(buildCopilotRuntimeHeaders()["Copilot-Integration-Id"]).toBe(
      COPILOT_RUNTIME_INTEGRATION_ID,
    );
  });

  it("carries the resolved override when one is provided", () => {
    expect(
      buildCopilotRuntimeHeaders({ integrationId: "vscode-chat" })["Copilot-Integration-Id"],
    ).toBe("vscode-chat");
  });
});
