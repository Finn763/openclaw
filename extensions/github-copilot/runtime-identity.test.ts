// Github Copilot tests cover runtime identity plugin behavior.
import { describe, expect, it, vi } from "vitest";
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

  it("warns once per invalid configured value so escape-hatch typos surface (#127287)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      resolveGithubCopilotIntegrationId({ config: configWithIntegrationId("warn-me once") }),
    ).toBe(COPILOT_RUNTIME_INTEGRATION_ID);
    expect(
      resolveGithubCopilotIntegrationId({ config: configWithIntegrationId("warn-me once") }),
    ).toBe(COPILOT_RUNTIME_INTEGRATION_ID);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("warn-me once");
    warnSpy.mockRestore();
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
