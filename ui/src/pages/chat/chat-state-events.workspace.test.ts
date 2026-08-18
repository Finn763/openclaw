import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { getSessionWorkspace } from "./components/chat-session-workspace-state.ts";
import { openSlot } from "./sidebar-layout.ts";

describe("session workspace terminal refresh", () => {
  it("reloads workspace facts only while the Files tab is visible", async () => {
    const listFiles = vi.fn().mockResolvedValue({ sessionKey: "agent:main", files: [] });
    const request = vi.fn().mockResolvedValue({ artifacts: [] });
    const state = makeChatHost({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { listFiles, reconcileRunTerminal: vi.fn() } as never,
    }) as unknown as ChatPageHost;
    state.chatMessagesBySession = new Map();
    state.pendingSessionMessageReloadSessionKey = null;
    state.sidebarLayout = openSlot(openSlot({ columns: [] }, "workspace"), "terminal");
    getSessionWorkspace(state);

    const emitFinal = (runId: string) =>
      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: {
          state: "final",
          runId,
          sessionKey: state.sessionKey,
          message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
        },
      });

    emitFinal("hidden-workspace-run");
    expect(listFiles).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([method]) => method === "artifacts.list")).toHaveLength(0);

    state.sidebarLayout = openSlot(state.sidebarLayout, "workspace");
    emitFinal("visible-workspace-run");

    await vi.waitFor(() => expect(listFiles).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "artifacts.list")).toHaveLength(1),
    );
  });
});
