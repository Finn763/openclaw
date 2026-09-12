import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  call,
  dismissPendingTaskSuggestions,
  requirePayload,
  SOURCE_SESSION_KEY,
} from "./task-suggestions.test-support.js";
import type { RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({ handleChatSend: vi.fn() }));
vi.mock("./chat-send-handler.js", () => ({ handleChatSend: mocks.handleChatSend }));

const BASE_CWD = "/workspace";

beforeEach(async () => {
  await dismissPendingTaskSuggestions();
  mocks.handleChatSend.mockReset();
  mocks.handleChatSend.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
    respond(true, { runId: "suggested-task-run", status: "started" }, undefined);
  });
});

afterEach(async () => {
  await dismissPendingTaskSuggestions();
  closeOpenClawAgentDatabasesForTest();
});

type SandboxConfigParams = {
  workspace: string;
  storePath: string;
  workspaceAccess?: "rw" | "none";
  workspaceRoot?: string;
};

function sandboxedConfig(params: SandboxConfigParams) {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend: "docker",
          scope: "agent",
          ...(params.workspaceAccess ? { workspaceAccess: params.workspaceAccess } : {}),
          ...(params.workspaceRoot ? { workspaceRoot: params.workspaceRoot } : {}),
        },
      },
      entries: { main: { workspace: params.workspace } },
    },
    session: { store: params.storePath },
  };
}

async function createSuggestion(params: { config: unknown; cwd: string }) {
  return await call(
    "taskSuggestions.create",
    {
      title: "Fix the sandbox follow-up",
      prompt: "Apply the focused fix flagged inside the sandbox.",
      tldr: "The follow-up was recorded from a sandboxed session.",
      cwd: params.cwd,
      sessionKey: SOURCE_SESSION_KEY,
      agentId: "main",
    },
    vi.fn(),
    { config: params.config as Record<string, unknown> },
  );
}

function requireSuggestion(result: Awaited<ReturnType<typeof createSuggestion>>) {
  const payload = requirePayload(result) as { taskId: string; suggestion: { cwd: string } };
  return payload;
}

describe("task suggestion host cwd for sandboxed sessions", () => {
  it("maps the container workspace path to the host workspace and accepts the card", async () => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      const workspace = await fs.realpath(state.workspaceDir);
      const config = sandboxedConfig({
        workspace,
        storePath: state.statePath("agents", "{agentId}", "sessions", "sessions.json"),
        workspaceAccess: "rw",
      });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
        { sessionId: "follow-up-source", updatedAt: 1 },
      );

      const created = await createSuggestion({ config, cwd: BASE_CWD });
      const { taskId, suggestion } = requireSuggestion(created);
      expect(suggestion.cwd).toBe(workspace);

      const accepted = await call("taskSuggestions.accept", { taskId, mode: "local" }, vi.fn(), {
        config,
        context: {
          loadGatewayModelCatalog: async () => [],
          getSessionEventSubscriberConnIds: () => new Set(),
        },
      });
      expect(accepted.response?.[2]).toBeUndefined();
      const { key } = requirePayload(accepted) as { key: string };
      const entry = loadSessionEntry({ agentId: "main", sessionKey: key });
      expect(entry).toMatchObject({ spawnedCwd: workspace, parentSessionKey: SOURCE_SESSION_KEY });
    });
  });

  it("maps container subpaths onto the host sandbox workspace", async () => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      const workspace = await fs.realpath(state.workspaceDir);
      await fs.mkdir(path.join(workspace, "nested", "project"), { recursive: true });
      const config = sandboxedConfig({
        workspace,
        storePath: state.statePath("agents", "{agentId}", "sessions", "sessions.json"),
        workspaceAccess: "rw",
      });

      const created = await createSuggestion({
        config,
        cwd: `${BASE_CWD}/nested/project`,
      });

      expect(requireSuggestion(created).suggestion.cwd).toBe(
        path.join(workspace, "nested", "project"),
      );
    });
  });

  it("maps to the session sandbox workspace when workspaceAccess does not admit the agent workspace", async () => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      const workspace = await fs.realpath(state.workspaceDir);
      const workspaceRoot = state.statePath("sandboxes");
      const config = sandboxedConfig({
        workspace,
        storePath: state.statePath("agents", "{agentId}", "sessions", "sessions.json"),
        workspaceRoot,
      });

      const created = await createSuggestion({ config, cwd: BASE_CWD });
      const { cwd } = requireSuggestion(created).suggestion;

      expect(cwd.startsWith(`${workspaceRoot}${path.sep}`)).toBe(true);
      expect(cwd).not.toBe(workspace);
      expect((await fs.stat(cwd)).isDirectory()).toBe(true);
    });
  });

  it("rejects a sandbox cwd the host cannot resolve instead of recording it", async () => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      const workspace = await fs.realpath(state.workspaceDir);
      const config = sandboxedConfig({
        workspace,
        storePath: state.statePath("agents", "{agentId}", "sessions", "sessions.json"),
        workspaceAccess: "rw",
      });

      const result = await createSuggestion({ config, cwd: "/sandbox-only/folder" });

      expect(result.response?.[0]).toBe(false);
      expect(result.response?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
      expect(result.response?.[2]?.message).toContain("task suggestion cwd is unavailable");
      expect(result.response?.[2]?.message).toContain(workspace);
      expect(result.broadcast).not.toHaveBeenCalled();
    });
  });

  it("keeps a host workspace path unchanged for sandboxed sessions", async () => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      const workspace = await fs.realpath(state.workspaceDir);
      const config = sandboxedConfig({
        workspace,
        storePath: state.statePath("agents", "{agentId}", "sessions", "sessions.json"),
        workspaceAccess: "rw",
      });

      const created = await createSuggestion({ config, cwd: workspace });

      expect(requireSuggestion(created).suggestion.cwd).toBe(workspace);
    });
  });
});
