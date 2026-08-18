import { describe, expect, it, vi } from "vitest";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createChatPaneRails } from "./chat-pane-rails.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { isSidebarSlotVisible, openSlot } from "./sidebar-layout.ts";

describe("chat pane rails", () => {
  it("activates a stored Workspace tab when Terminal is currently visible", () => {
    const sidebarLayout = openSlot(openSlot({ columns: [] }, "workspace"), "terminal");
    const state = makeChatHost({ connected: false }) as unknown as ChatPageHost;
    state.sidebarLayout = sidebarLayout;
    state.updateSidebarLayout = vi.fn((layout) => {
      state.sidebarLayout = layout;
    });

    const rails = createChatPaneRails({
      state,
      sidebarLayout,
      paneWidth: 1_000,
      presentationId: "pane-left",
      gatewaySnapshot: { hello: null } as never,
      setObserverVisibility: vi.fn(),
    });

    expect(rails.sessionWorkspace.collapsed).toBe(true);
    rails.sessionWorkspace.onToggleCollapsed();

    expect(state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "workspace",
      "terminal",
    ]);
    expect(isSidebarSlotVisible(state.sidebarLayout, "workspace")).toBe(true);
  });
});
