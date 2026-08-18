import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createProviderApiKeyAuthMethod } from "./provider-api-key-auth.js";

describe("createProviderApiKeyAuthMethod", () => {
  it("clears stale failure state when a flag replaces a stored credential", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-provider-api-key-reauth-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const now = Date.now();
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        fs.mkdirSync(agentDir, { recursive: true });
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "example:default": { type: "api_key", provider: "example", key: "old-key" },
            },
            usageStats: {
              "example:default": {
                errorCount: 4,
                disabledUntil: now + 60_000,
                disabledReason: "auth_permanent",
                failureCounts: { auth_permanent: 4 },
              },
            },
          },
          agentDir,
        );
        const method = createProviderApiKeyAuthMethod({
          providerId: "example",
          methodId: "api-key",
          label: "Example",
          optionKey: "exampleApiKey",
          flagName: "--example-api-key",
          envVar: "EXAMPLE_API_KEY",
          promptMessage: "Example API key",
        });

        await method.runNonInteractive?.({
          authChoice: "example-api-key",
          config: {},
          baseConfig: {},
          opts: { exampleApiKey: "fresh-key" },
          agentDir,
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
          resolveApiKey: vi.fn(async () => ({ key: "fresh-key", source: "flag" as const })),
          toApiKeyCredential: vi.fn(() => ({
            type: "api_key" as const,
            provider: "example",
            key: "fresh-key",
          })),
        });

        const persisted = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
        expect(persisted.profiles["example:default"]).toMatchObject({ key: "fresh-key" });
        expect(persisted.usageStats?.["example:default"]).toEqual({
          credentialGeneration: 1,
          errorCount: 0,
        });
      });
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("exposes side-effect-free non-interactive credential validation", async () => {
    const method = createProviderApiKeyAuthMethod({
      providerId: "example",
      methodId: "api-key",
      label: "Example",
      optionKey: "exampleApiKey",
      flagName: "--example-api-key",
      envVar: "EXAMPLE_API_KEY",
      promptMessage: "Example API key",
    });
    const resolveApiKey = vi.fn(async () => ({ key: "test-token", source: "flag" as const }));

    const valid = await method.validateNonInteractive?.({
      authChoice: "example-api-key",
      config: {},
      baseConfig: {},
      opts: { exampleApiKey: "test-token" },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
      resolveApiKey,
    });

    expect(valid).toBe(true);
    expect(resolveApiKey).toHaveBeenCalledWith({
      provider: "example",
      flagValue: "test-token",
      flagName: "--example-api-key",
      envVar: "EXAMPLE_API_KEY",
    });
  });

  it("applies a key-scoped default model during non-interactive auth", async () => {
    const resolveDefaultModel = vi.fn(async () => "example/enabled-model");
    const method = createProviderApiKeyAuthMethod({
      providerId: "example",
      methodId: "api-key",
      label: "Example",
      optionKey: "exampleApiKey",
      flagName: "--example-api-key",
      envVar: "EXAMPLE_API_KEY",
      promptMessage: "Example API key",
      defaultModel: "example/static-model",
      resolveDefaultModel,
    });

    const config = await method.runNonInteractive?.({
      authChoice: "example-api-key",
      config: {},
      baseConfig: {},
      opts: { exampleApiKey: "test-token" },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
      resolveApiKey: vi.fn(async () => ({ key: "test-token", source: "profile" as const })),
      toApiKeyCredential: vi.fn(() => null),
    });

    expect(resolveDefaultModel).toHaveBeenCalledWith({ apiKey: "test-token", config: {} });
    expect(config?.agents?.defaults?.model).toEqual({ primary: "example/enabled-model" });
  });

  it.each([
    {
      name: "falls back to the static model when discovery fails",
      resolveDefaultModel: async () => {
        throw new Error("catalog unavailable");
      },
      expected: { primary: "example/static-model" },
    },
    {
      name: "leaves the model unset when discovery finds no safe default",
      resolveDefaultModel: async () => undefined,
      expected: undefined,
    },
  ])("$name", async ({ resolveDefaultModel, expected }) => {
    const method = createProviderApiKeyAuthMethod({
      providerId: "example",
      methodId: "api-key",
      label: "Example",
      optionKey: "exampleApiKey",
      flagName: "--example-api-key",
      envVar: "EXAMPLE_API_KEY",
      promptMessage: "Example API key",
      defaultModel: "example/static-model",
      resolveDefaultModel,
    });

    const config = await method.runNonInteractive?.({
      authChoice: "example-api-key",
      config: {},
      baseConfig: {},
      opts: { exampleApiKey: "test-token" },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
      resolveApiKey: vi.fn(async () => ({ key: "test-token", source: "profile" as const })),
      toApiKeyCredential: vi.fn(() => null),
    });

    expect(config?.agents?.defaults?.model).toEqual(expected);
  });

  it("returns a key-scoped default model during interactive auth", async () => {
    const resolveDefaultModel = vi.fn(async () => "example/enabled-model");
    const method = createProviderApiKeyAuthMethod({
      providerId: "example",
      methodId: "api-key",
      label: "Example",
      optionKey: "exampleApiKey",
      flagName: "--example-api-key",
      envVar: "EXAMPLE_API_KEY",
      promptMessage: "Example API key",
      defaultModel: "example/static-model",
      resolveDefaultModel,
    });

    const result = await method.run({
      config: {},
      env: {},
      opts: { exampleApiKey: "test-token" },
      prompter: { note: vi.fn() },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      secretInputMode: "plaintext",
    } as never);

    expect(resolveDefaultModel).toHaveBeenCalledWith({ apiKey: "test-token", config: {} });
    expect(result.defaultModel).toBe("example/enabled-model");
  });
});
