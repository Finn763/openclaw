import { describe, expect, it, vi } from "vitest";
import { readAcpSessionMeta } from "../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";

describe("plugin native action evidence", () => {
  it("marks a persisted ACP session as lacking an OpenClaw action callback", async () => {
    await withOpenClawTestState({ label: "plugin-native-action-evidence" }, async () => {
      const runtime = createPluginRuntime();
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
      const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
      const created = await api.runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "plugin:opencode:catalog-adopt:source",
        initialEntry: {
          acpBackendId: "acpx",
          acpSessionBinding: {
            acpAgentId: "opencode",
            agentSessionId: "native-session",
          },
        },
      });

      expect(created.entry.acpSessionBinding).toBeUndefined();
      expect(readAcpSessionMeta({ cfg: {}, sessionKey: created.key })).toMatchObject({
        backend: "acpx",
        agent: "opencode",
      });
      await expect(
        api.runtime.agent.runEmbeddedAgent({
          prompt: "continue",
          runId: "run-acp-native",
          sessionId: created.sessionId,
          sessionKey: created.key,
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
});
