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

  it("warns for every present invalid configured value so nothing falls back silently (#127287)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Non-empty malformed string.
    expect(
      resolveGithubCopilotIntegrationId({ config: configWithIntegrationId("warn-me once") }),
    ).toBe(COPILOT_RUNTIME_INTEGRATION_ID);
    // Numeric value.
    expect(resolveGithubCopilotIntegrationId({ config: configWithIntegrationId(42) })).toBe(
      COPILOT_RUNTIME_INTEGRATION_ID,
    );
    // Empty string.
    expect(resolveGithubCopilotIntegrationId({ config: configWithIntegrationId("") })).toBe(
      COPILOT_RUNTIME_INTEGRATION_ID,
    );
    // Non-string value (boolean).
    expect(resolveGithubCopilotIntegrationId({ config: configWithIntegrationId(true) })).toBe(
      COPILOT_RUNTIME_INTEGRATION_ID,
    );
    // A repeated value still warns only once.
    expect(
      resolveGithubCopilotIntegrationId({ config: configWithIntegrationId("warn-me once") }),
    ).toBe(COPILOT_RUNTIME_INTEGRATION_ID);

    // Every distinct present-invalid shape fell back to the default AND surfaced a warning.
    expect(warnSpy).toHaveBeenCalledTimes(4);
    const messages = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(messages).toEqual([
      expect.stringContaining("warn-me once"),
      expect.stringContaining("42"),
      expect.stringContaining('""'),
      expect.stringContaining("true"),
    ]);
    warnSpy.mockRestore();
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
