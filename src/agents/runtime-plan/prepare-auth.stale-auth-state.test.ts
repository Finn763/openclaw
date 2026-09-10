/**
 * Stale `auth_profile_state.order` entries must never select a provider route.
 *
 * Issue #144066 reported gpt-5.4/gpt-5.4-mini requests reaching
 * chatgpt.com/backend-api/codex after openai OAuth profiles were removed while
 * `order.openai` kept referencing them. These cases pin the fail-closed
 * behavior of the shared selector: a profile id that has no credential in the
 * effective store cannot win a route, and therefore cannot select the
 * subscription (ChatGPT/Codex) transport over the api-key Platform transport.
 *
 * The route facts asserted here (openai-responses/api.openai.com vs
 * openai-chatgpt-responses/chatgpt.com) are exactly the two OpenAI transports
 * the report distinguishes.
 */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveProviderDeprecatedAuthProfileIds: () => [],
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: () => undefined,
}));

const MODEL = "gpt-5.4-mini";
const API_KEY_PROFILE = "openai:api-key";
const REMOVED_OAUTH_PROFILE = "openai:old@example.test";

function apiKeyProfile(provider: string, key: string) {
  return { type: "api_key" as const, provider, key };
}

function oauthProfile(provider: string, access: string, refresh: string, expires: number) {
  return { type: "oauth" as const, provider, access, refresh, expires };
}

function storeWithApiKey(extra: Partial<AuthProfileStore> = {}): AuthProfileStore {
  return {
    version: 1,
    profiles: { [API_KEY_PROFILE]: apiKeyProfile("openai", "sk-synthetic") },
    ...extra,
  };
}

function prepare(params: {
  store: AuthProfileStore;
  config?: OpenClawConfig;
  session?: { id: string; source: "auto" | "user" | "user-link" };
}) {
  return prepareAgentRuntimeAuth({
    provider: "openai",
    modelId: MODEL,
    ...(params.config ? { config: params.config } : {}),
    env: {},
    authProfileStore: params.store,
    ...(params.session
      ? {
          sessionAuthProfileId: params.session.id,
          sessionAuthProfileSource: params.session.source,
        }
      : {}),
  });
}

function routesOf(prepared: ReturnType<typeof prepareAgentRuntimeAuth>) {
  return prepared.attempts.map((attempt) => attempt.plan.modelRoute?.api);
}

describe("prepareAgentRuntimeAuth with stale auth_profile_state", () => {
  it("ignores order/lastGood/usageStats entries whose profiles were removed", () => {
    const prepared = prepare({
      store: storeWithApiKey({
        order: { openai: ["openai:manual", REMOVED_OAUTH_PROFILE, API_KEY_PROFILE] },
        lastGood: { openai: REMOVED_OAUTH_PROFILE },
        usageStats: { [REMOVED_OAUTH_PROFILE]: { lastUsed: 1 } },
      }),
    });

    expect({
      profileIds: prepared.attempts.map((attempt) => attempt.profileId),
      routes: routesOf(prepared),
    }).toEqual({ profileIds: [API_KEY_PROFILE], routes: ["openai-responses"] });
    expect(prepared.attempts[0]?.plan.modelRoute?.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("ignores a config-declared oauth profile that has no stored credential", () => {
    const prepared = prepare({
      store: storeWithApiKey(),
      config: {
        auth: {
          order: { openai: [REMOVED_OAUTH_PROFILE, API_KEY_PROFILE] },
          profiles: { [REMOVED_OAUTH_PROFILE]: { provider: "openai", mode: "oauth" } },
        },
      },
    });

    expect({
      profileIds: prepared.attempts.map((attempt) => attempt.profileId),
      routes: routesOf(prepared),
    }).toEqual({ profileIds: [API_KEY_PROFILE], routes: ["openai-responses"] });
  });

  it("ignores an automatic session pin that points at a removed profile", () => {
    const prepared = prepare({
      store: storeWithApiKey(),
      session: { id: REMOVED_OAUTH_PROFILE, source: "auto" },
    });

    expect({
      profileIds: prepared.attempts.map((attempt) => attempt.profileId),
      routes: routesOf(prepared),
    }).toEqual({ profileIds: [API_KEY_PROFILE], routes: ["openai-responses"] });
  });

  it("rejects a user-pinned profile that no longer has a credential", () => {
    expect(() =>
      prepare({
        store: storeWithApiKey(),
        session: { id: REMOVED_OAUTH_PROFILE, source: "user" },
      }),
    ).toThrow(/unavailable/);
  });

  it("selects the subscription route only when a subscription credential exists", () => {
    // Positive control: this is the shape that reaches chatgpt.com/backend-api/codex.
    // It requires real stored oauth/token material for provider openai, which is why
    // dangling order entries alone cannot produce the reported misroute.
    const prepared = prepare({
      store: {
        version: 1,
        profiles: {
          "openai:chatgpt": oauthProfile("openai", "access", "refresh", Date.now() + 3_600_000),
          [API_KEY_PROFILE]: apiKeyProfile("openai", "sk-synthetic"),
        },
      },
    });

    expect(routesOf(prepared)).toEqual(["openai-chatgpt-responses", "openai-responses"]);
    expect(prepared.attempts[0]?.plan.modelRoute?.baseUrl).toBe(
      "https://chatgpt.com/backend-api/codex",
    );
  });
});
