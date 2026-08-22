// Github Copilot tests cover dynamic model catalog behavior.
import { describe, expect, it, vi } from "vitest";

const getCachedLiveCatalogValueMock = vi.hoisted(() =>
  vi.fn(async <T>(params: { keyParts: readonly unknown[]; load: () => Promise<T> }) =>
    params.load(),
  ),
);

vi.mock("openclaw/plugin-sdk/provider-catalog-shared", () => ({
  getCachedLiveCatalogValue: getCachedLiveCatalogValueMock,
}));

const resolveFirstGithubTokenMock = vi.hoisted(() => vi.fn());
const resolveCopilotRuntimeAuthMock = vi.hoisted(() => vi.fn());
const fetchCopilotModelCatalogMock = vi.hoisted(() => vi.fn());

vi.mock("./auth.js", () => ({
  resolveFirstGithubToken: resolveFirstGithubTokenMock,
}));

vi.mock("./register.runtime.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.individual.githubcopilot.com",
  resolveCopilotRuntimeAuth: resolveCopilotRuntimeAuthMock,
}));

vi.mock("./models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models.js")>();
  return {
    ...actual,
    fetchCopilotModelCatalog: fetchCopilotModelCatalogMock,
  };
});

import { createGithubCopilotDynamicModelHooks } from "./dynamic-models.js";

function catalogContext(integrationId: string) {
  return {
    env: process.env,
    config: {
      models: {
        providers: {
          "github-copilot": { params: { integrationId } },
        },
      },
    },
  } as never;
}

describe("github-copilot dynamic model catalog cache identity", () => {
  it("includes the resolved integration id in the catalog cache key (#127287)", async () => {
    resolveFirstGithubTokenMock.mockResolvedValue({ githubToken: "gh-token", hasProfile: true });
    resolveCopilotRuntimeAuthMock.mockResolvedValue({
      apiKey: "tid=test",
      source: "test",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    fetchCopilotModelCatalogMock.mockResolvedValue([]);

    const hooks = createGithubCopilotDynamicModelHooks({ discoveryEnabled: () => true });

    await hooks.runCatalog(catalogContext("vscode-chat"));
    await hooks.runCatalog(catalogContext("copilot-developer-cli"));

    const keys = getCachedLiveCatalogValueMock.mock.calls.map(
      (call) => (call[0] as { keyParts: readonly unknown[] }).keyParts,
    );
    expect(keys[0]?.at(-1)).toBe("vscode-chat");
    expect(keys[1]?.at(-1)).toBe("copilot-developer-cli");
    expect(keys[0]).not.toEqual(keys[1]);
  });
});
