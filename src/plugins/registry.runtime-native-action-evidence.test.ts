import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";

describe("plugin native action evidence", () => {
  it("marks a persisted ACP session as lacking an OpenClaw action callback", async () => {
    const sessionKey = "plugin:opencode:catalog-adopt:source";
    const entry = {
      sessionId: "acp-session",
      updatedAt: 1,
      pluginOwnerId: "opencode",
      acpSessionBinding: {
        acpBackendId: "acpx",
        acpAgentId: "opencode",
        agentSessionId: "native-session",
      },
    } satisfies SessionEntry;
    const runtime = createPluginRuntime();
    runtime.agent.session.getSessionEntry = vi.fn(() => entry);
    runtime.agent.session.listSessionEntries = vi.fn(() => [{ sessionKey, entry }]);
    let observedScope = getPluginRuntimeGatewayRequestScope();
    Object.defineProperty(runtime.agent, "runEmbeddedAgent", {
      configurable: true,
      value: vi.fn(async () => {
        observedScope = getPluginRuntimeGatewayRequestScope();
        return { ok: true };
      }),
    });
    const pluginRegistry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime,
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: "opencode",
      source: "/plugins/opencode/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });

    await expect(
      pluginRegistry
        .createApi(record, { config: {} as OpenClawConfig })
        .runtime.agent.runEmbeddedAgent({
          prompt: "continue",
          runId: "run-acp-native",
          sessionId: entry.sessionId,
          sessionKey,
          timeoutMs: 1,
          workspaceDir: "/tmp",
        }),
    ).resolves.toEqual({ ok: true });
    expect(observedScope).toMatchObject({
      pluginId: "opencode",
      nativeActionEvidence: "unsupported",
    });
  });
});
