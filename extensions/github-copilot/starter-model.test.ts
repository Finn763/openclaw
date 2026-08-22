// Github Copilot tests cover starter model plugin behavior.
import { describe, expect, it, vi } from "vitest";

const resolveCopilotRuntimeAuthMock = vi.hoisted(() => vi.fn());
const fetchCopilotModelCatalogMock = vi.hoisted(() => vi.fn());

vi.mock("./runtime-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-auth.js")>()),
  resolveCopilotRuntimeAuth: resolveCopilotRuntimeAuthMock,
}));

vi.mock("./models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models.js")>();
  return {
    ...actual,
    fetchCopilotModelCatalog: fetchCopilotModelCatalogMock,
  };
});

import { resolveCopilotStarterModel } from "./starter-model.js";

describe("resolveCopilotStarterModel", () => {
  it("sends the configured integrationId during catalog discovery (GHE data residency)", async () => {
    resolveCopilotRuntimeAuthMock.mockResolvedValue({
      apiKey: "tid=test",
      baseUrl: "https://api.githubcopilot.com",
    });
    fetchCopilotModelCatalogMock.mockResolvedValue([]);

    await expect(
      resolveCopilotStarterModel({
        githubToken: "github-token",
        config: {
          models: {
            providers: {
              "github-copilot": { params: { integrationId: "vscode-chat" } },
            },
          },
        },
      }),
    ).rejects.toThrow();

    expect(fetchCopilotModelCatalogMock).toHaveBeenCalledWith({
      copilotApiToken: "tid=test",
      baseUrl: "https://api.githubcopilot.com",
      integrationId: "vscode-chat",
    });
  });
});
