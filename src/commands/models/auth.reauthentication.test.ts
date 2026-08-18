// Model auth reauthentication tests cover persisted credential and routing state replacement.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "../../agents/auth-profiles/constants.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { isProfileInCooldown } from "../../agents/auth-profiles/usage-state.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { WizardPrompter } from "../../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  resolvePluginProvidersCore: vi.fn<() => ProviderPlugin[]>(),
  resolvePluginSetupProviderCore: vi.fn(() => undefined),
  resolvePluginSetupRegistry: vi.fn(() => ({ providers: [] })),
  callGateway: vi.fn(async () => ({})),
}));

vi.mock("../../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: mocks.resolvePluginProvidersCore,
}));

vi.mock("../../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: mocks.resolvePluginSetupProviderCore,
  resolvePluginSetupRegistry: mocks.resolvePluginSetupRegistry,
}));

vi.mock("../../gateway/call.js", () => ({ callGateway: mocks.callGateway }));

const { runModelsAuthLoginFlowCore } = await import("./auth.js");
const PROFILE_ID = "fixture:login";

function createRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function createPrompter(): WizardPrompter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(async () => {}),
    select: vi.fn(),
    multiselect: vi.fn(),
    text: vi.fn(),
    confirm: vi.fn(),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

function createProvider(run: ProviderAuthMethod["run"]): ProviderPlugin {
  return {
    id: "fixture",
    label: "Fixture",
    auth: [{ id: "oauth", label: "OAuth", kind: "oauth", run }],
  };
}

function createStaleStore(now: number): AuthProfileStore {
  return {
    version: AUTH_STORE_VERSION,
    profiles: {
      [PROFILE_ID]: {
        type: "oauth",
        provider: "fixture",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: now - 60_000,
      },
    },
    usageStats: {
      [PROFILE_ID]: {
        errorCount: 4,
        failureCounts: { auth_permanent: 4 },
        disabledUntil: now + 60_000,
        disabledReason: "auth_permanent",
      },
    },
  };
}

async function withStaleProfile(
  run: (fixture: { agentDir: string; now: number }) => Promise<void>,
): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-auth-reauth-"));
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const now = Date.now();
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      try {
        fs.mkdirSync(agentDir, { recursive: true });
        saveAuthProfileStore(createStaleStore(now), agentDir, {
          filterExternalAuthProfiles: false,
        });
        await run({ agentDir, now });
      } finally {
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  vi.clearAllMocks();
});

describe("models auth reauthentication", () => {
  it("makes the replaced profile usable after a successful login", async () => {
    await withStaleProfile(async ({ agentDir, now }) => {
      mocks.resolvePluginProvidersCore.mockReturnValue([
        createProvider(async () => ({
          profiles: [
            {
              profileId: PROFILE_ID,
              credential: {
                type: "oauth",
                provider: "fixture",
                access: "fresh-access",
                refresh: "fresh-refresh",
                expires: now + 60_000,
              },
            },
          ],
        })),
      ]);

      await runModelsAuthLoginFlowCore({
        provider: "fixture",
        config: {},
        runtime: createRuntime(),
        prompter: createPrompter(),
      });

      const persisted = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
      expect(persisted.profiles[PROFILE_ID]).toMatchObject({
        type: "oauth",
        provider: "fixture",
        access: "fresh-access",
        refresh: "fresh-refresh",
      });
      expect(persisted.usageStats?.[PROFILE_ID]).toEqual({
        credentialGeneration: 1,
        errorCount: 0,
      });
      expect(isProfileInCooldown(persisted, PROFILE_ID, now)).toBe(false);
    });
  });

  it("preserves the existing profile state when login fails", async () => {
    await withStaleProfile(async ({ agentDir, now }) => {
      mocks.resolvePluginProvidersCore.mockReturnValue([
        createProvider(async () => {
          throw new Error("fixture login failed");
        }),
      ]);

      await expect(
        runModelsAuthLoginFlowCore({
          provider: "fixture",
          config: {},
          runtime: createRuntime(),
          prompter: createPrompter(),
        }),
      ).rejects.toThrow("fixture login failed");

      const persisted = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
      expect(persisted.profiles[PROFILE_ID]).toMatchObject({
        access: "expired-access",
        refresh: "expired-refresh",
      });
      expect(persisted.usageStats?.[PROFILE_ID]).toEqual({
        errorCount: 4,
        failureCounts: { auth_permanent: 4 },
        disabledUntil: now + 60_000,
        disabledReason: "auth_permanent",
      });
    });
  });
});
