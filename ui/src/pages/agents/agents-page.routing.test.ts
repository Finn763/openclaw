/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { AgentsPanel } from "../../lib/agents/panels.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { AgentsRouteData } from "./route.ts";
import "./agents-page.ts";

type RoutingAgentsPage = HTMLElement & {
  context: ApplicationContext;
  agentsList: AgentsListResult;
  agentsSelectedId: string | null;
  routeData?: AgentsRouteData;
  readonly agentsPanel: AgentsPanel;
};

describe("AgentsPage routing", () => {
  it("derives the panel from route data", () => {
    const gatewaySnapshot: ApplicationGatewaySnapshot = {
      client: null,
      phase: "stopped",
      offlineStable: false,
      canvasPluginSurfaceUrl: null,
      hello: gatewayHelloForMethods(["config.patch", "config.set"]),
      assistantAgentId: null,
      sessionKey: "main",
      lastError: null,
      lastErrorCode: null,
    };
    const gateway = {
      snapshot: gatewaySnapshot,
      subscribe: vi.fn(() => () => undefined),
    } as unknown as ApplicationContext["gateway"];
    const page = document.createElement("openclaw-agents-page") as RoutingAgentsPage;
    page.context = { basePath: "/ui", gateway } as unknown as ApplicationContext;
    page.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "Main" },
        { id: "research", name: "Research" },
      ],
    };
    page.agentsSelectedId = "main";
    page.routeData = {
      gateway,
      gatewaySnapshot,
      location: { pathname: "/ui/settings/agents/main/tools", search: "", hash: "" },
      requestedAgentId: "main",
      panel: "tools",
      agentsList: page.agentsList,
      selectedAgentId: "main",
      error: null,
    };

    expect(page.agentsPanel).toBe("tools");
    expect(page.agentsSelectedId).toBe("main");
  });
});
