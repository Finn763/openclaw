/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { invalidateModelCatalogStore } from "../../lib/chat/model-catalog-store.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { AgentsRouteData } from "./route.ts";
import "./agents-page.ts";

type ModelCatalogAgentsPage = HTMLElement & {
  readonly client: GatewayBrowserClient | null;
  agentsSelectedId: string | null;
  routeData?: AgentsRouteData;
  chatModelCatalog: ModelCatalogEntry[];
  chatModelCatalogError: string | null;
  chatModelCatalogRequest: unknown;
  loadActivePanelData: () => void;
  ensureModelCatalog: (options?: { refresh?: boolean }) => void;
  gateway: {
    applySnapshot: (
      snapshot: ApplicationGatewaySnapshot,
      binding: { initial: boolean; sourceChanged: boolean },
    ) => void;
    invalidate: () => void;
  };
};

function snapshot(
  client: GatewayBrowserClient | null,
  connected = true,
): ApplicationGatewaySnapshot {
  return {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods(["config.patch", "config.set"]),
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

function setPageGateway(
  page: ModelCatalogAgentsPage,
  client: GatewayBrowserClient | null,
  connected = true,
) {
  page.gateway.applySnapshot(snapshot(client, connected), {
    initial: false,
    sourceChanged: false,
  });
}

function createOverviewPage(client: GatewayBrowserClient): ModelCatalogAgentsPage {
  const page = document.createElement("openclaw-agents-page") as ModelCatalogAgentsPage;
  page.routeData = { panel: "overview" } as AgentsRouteData;
  setPageGateway(page, client);
  page.agentsSelectedId = "main";
  return page;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function expectPreparedModelsRequest(
  request: ReturnType<typeof vi.fn>,
  call: number,
  agentId: string,
) {
  expect(request).toHaveBeenNthCalledWith(call, "models.list", {
    agentId,
    preparedOnly: true,
    view: "configured",
  });
}

describe("AgentsPage model catalog", () => {
  it("loads the selected agent's configured model catalog once for the overview model picker", async () => {
    const models = [
      {
        id: "claude-opus-4-8",
        name: "Opus 4.8",
        alias: "opus",
        provider: "anthropic",
      },
    ];
    const request = vi.fn(async () => ({ models }));
    const page = createOverviewPage({ request } as unknown as GatewayBrowserClient);

    page.loadActivePanelData();
    page.loadActivePanelData();

    await vi.waitFor(() => expect(page.chatModelCatalog).toEqual(models));
    expect(request).toHaveBeenCalledOnce();
    expectPreparedModelsRequest(request, 1, "main");
  });

  it("caches separate configured model catalogs for the default and worker agents", async () => {
    const defaultModels = [
      { id: "default-model", name: "Default account model", provider: "openai" },
    ];
    const workerModels = [
      { id: "worker-model", name: "Worker private model", provider: "anthropic" },
    ];
    const request = vi.fn(async (_method: string, params?: { agentId?: string }) => ({
      models: params?.agentId === "worker" ? workerModels : defaultModels,
    }));
    const page = createOverviewPage({ request } as unknown as GatewayBrowserClient);

    page.loadActivePanelData();
    await vi.waitFor(() => expect(page.chatModelCatalog).toEqual(defaultModels));

    page.agentsSelectedId = "worker";
    page.loadActivePanelData();
    await vi.waitFor(() => expect(page.chatModelCatalog).toEqual(workerModels));

    page.agentsSelectedId = "main";
    page.loadActivePanelData();
    expect(page.chatModelCatalog).toEqual(defaultModels);
    expect(request).toHaveBeenCalledTimes(2);
    expectPreparedModelsRequest(request, 1, "main");
    expectPreparedModelsRequest(request, 2, "worker");
  });

  it("rejects a stale default-agent catalog after switching to a worker agent", async () => {
    const defaultModels = [
      { id: "default-model", name: "Default account model", provider: "openai" },
    ];
    const workerModels = [
      { id: "worker-model", name: "Worker private model", provider: "anthropic" },
    ];
    const defaultResult = deferred<{ models: ModelCatalogEntry[] }>();
    const request = vi.fn((_method: string, params?: { agentId?: string }) =>
      params?.agentId === "worker"
        ? Promise.resolve({ models: workerModels })
        : defaultResult.promise,
    );
    const page = createOverviewPage({ request } as unknown as GatewayBrowserClient);

    page.loadActivePanelData();
    page.agentsSelectedId = "worker";
    page.loadActivePanelData();

    await vi.waitFor(() => expect(page.chatModelCatalog).toEqual(workerModels));
    defaultResult.resolve({ models: defaultModels });
    await defaultResult.promise;
    await Promise.resolve();

    expect(page.chatModelCatalog).toEqual(workerModels);
    expect(request).toHaveBeenCalledTimes(2);
    expectPreparedModelsRequest(request, 2, "worker");
  });

  it("re-reads a cached model catalog when the picker asks for a refresh", async () => {
    const oldModels = [{ id: "old", name: "Old Model", alias: "opus", provider: "anthropic" }];
    const nextModels = [{ id: "new", name: "Opus 4.8", alias: "opus", provider: "anthropic" }];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: oldModels })
      .mockResolvedValueOnce({ models: nextModels });
    const page = createOverviewPage({ request } as unknown as GatewayBrowserClient);

    page.loadActivePanelData();
    await vi.waitFor(() => expect(page.chatModelCatalog).toEqual(oldModels));

    page.ensureModelCatalog();
    expect(request).toHaveBeenCalledTimes(1);

    page.ensureModelCatalog({ refresh: true });
    await vi.waitFor(() => expect(page.chatModelCatalog).toEqual(nextModels));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("revalidates an expired prepared catalog on overview re-entry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
      const oldModels = [{ id: "old", name: "Old Model", provider: "anthropic" }];
      const nextModels = [{ id: "new", name: "New Model", provider: "anthropic" }];
      const request = vi
        .fn()
        .mockResolvedValueOnce({ models: oldModels })
        .mockResolvedValueOnce({ models: nextModels });
      const page = createOverviewPage({ request } as unknown as GatewayBrowserClient);

      page.loadActivePanelData();
      await vi.waitFor(() => expect(page.chatModelCatalog).toEqual(oldModels));

      vi.setSystemTime(new Date("2026-08-19T00:00:00Z"));
      page.ensureModelCatalog();
      await vi.waitFor(() => expect(page.chatModelCatalog).toEqual(nextModels));

      expect(request).toHaveBeenCalledTimes(2);
      expectPreparedModelsRequest(request, 2, "main");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an old-client model catalog after the Gateway client changes", async () => {
    const oldModels = [{ id: "old", name: "Old Model", alias: "opus", provider: "anthropic" }];
    const nextModels = [{ id: "new", name: "Opus 4.8", alias: "opus", provider: "anthropic" }];
    const oldResult = deferred<{ models: ModelCatalogEntry[] }>();
    const oldRequest = vi.fn(() => oldResult.promise);
    const nextRequest = vi.fn(async () => ({ models: nextModels }));
    const page = createOverviewPage({ request: oldRequest } as unknown as GatewayBrowserClient);

    page.loadActivePanelData();
    page.gateway.invalidate();
    setPageGateway(page, { request: nextRequest } as unknown as GatewayBrowserClient);
    page.agentsSelectedId = "main";
    page.loadActivePanelData();

    await vi.waitFor(() => expect(page.chatModelCatalog).toEqual(nextModels));
    oldResult.resolve({ models: oldModels });
    await oldResult.promise;
    await Promise.resolve();

    expect(page.chatModelCatalog).toEqual(nextModels);
    expect(oldRequest).toHaveBeenCalledOnce();
    expect(nextRequest).toHaveBeenCalledOnce();
  });

  it("refreshes a stale in-flight model catalog after a same-client reconnect", async () => {
    const oldModels = [{ id: "old", name: "Old Model", alias: "opus", provider: "anthropic" }];
    const nextModels = [{ id: "new", name: "Opus 4.8", alias: "opus", provider: "anthropic" }];
    const oldResult = deferred<{ models: ModelCatalogEntry[] }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(oldResult.promise)
      .mockResolvedValueOnce({ models: nextModels });
    const page = createOverviewPage({ request } as unknown as GatewayBrowserClient);

    page.loadActivePanelData();
    page.gateway.invalidate();
    invalidateModelCatalogStore(page.client as GatewayBrowserClient);
    page.loadActivePanelData();

    await vi.waitFor(() => expect(page.chatModelCatalog).toEqual(nextModels));
    oldResult.resolve({ models: oldModels });
    await oldResult.promise;
    await Promise.resolve();

    expect(page.chatModelCatalog).toEqual(nextModels);
    expect(request).toHaveBeenCalledTimes(2);
    expectPreparedModelsRequest(request, 2, "main");
  });

  it("refreshes a settled model catalog after a same-client reconnect", async () => {
    const oldModels = [{ id: "old", name: "Old Model", alias: "opus", provider: "anthropic" }];
    const nextModels = [{ id: "new", name: "Opus 4.8", alias: "opus", provider: "anthropic" }];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: oldModels })
      .mockResolvedValueOnce({ models: nextModels });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = createOverviewPage(client);

    page.loadActivePanelData();
    await vi.waitFor(() => expect(page.chatModelCatalog).toEqual(oldModels));

    setPageGateway(page, client, false);
    expect(page.chatModelCatalog).toEqual([]);
    invalidateModelCatalogStore(client);
    setPageGateway(page, client);
    page.loadActivePanelData();

    await vi.waitFor(() => expect(page.chatModelCatalog).toEqual(nextModels));
    expect(request).toHaveBeenCalledTimes(2);
    expectPreparedModelsRequest(request, 2, "main");
  });

  it("surfaces a rejected agent-scoped metadata RPC and retries without marking an empty catalog loaded", async () => {
    const models = [{ id: "new", name: "Opus 4.8", alias: "opus", provider: "anthropic" }];
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("model catalog unavailable"))
      .mockResolvedValueOnce({ models });
    const page = createOverviewPage({ request } as unknown as GatewayBrowserClient);

    page.loadActivePanelData();
    await vi.waitFor(() => {
      expect(page.chatModelCatalogError).toBe("model catalog unavailable");
      expect(page.chatModelCatalogRequest).toBeNull();
    });
    expect(page.chatModelCatalog).toEqual([]);

    page.loadActivePanelData();
    await vi.waitFor(() => expect(page.chatModelCatalog).toEqual(models));

    expect(page.chatModelCatalogError).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expectPreparedModelsRequest(request, 2, "main");
  });
});
