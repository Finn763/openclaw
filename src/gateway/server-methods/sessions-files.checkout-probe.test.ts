import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  expectOkPayload,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
} from "./sessions-files.test-support.js";

const hoisted = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  readSessionTranscriptVisibleMessageDeltaCore: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  runGit: vi.fn(),
}));

vi.mock("../../agents/worktrees/git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/worktrees/git.js")>()),
  runGit: hoisted.runGit,
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
  loadSessionEntry: hoisted.loadSessionEntry,
}));

vi.mock("../session-transcript-readers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-transcript-readers.js")>()),
  readSessionTranscriptVisibleMessageDeltaCore:
    hoisted.readSessionTranscriptVisibleMessageDeltaCore,
}));

const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const mockVisibleMessages = createVisibleMessagesMock(
  hoisted.readSessionTranscriptVisibleMessageDeltaCore,
);

describe("sessions.files checkout probes", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = prepareSessionFilesTest(hoisted, mockVisibleMessages);
  });

  afterEach(() => removeWorkspaceFixture(workspaceRoot));

  it("coalesces only concurrent list probes", async () => {
    let finishProbe: (result: { code: number; stderr: string; stdout: string }) => void = () => {};
    hoisted.runGit.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finishProbe = resolve;
        }),
    );

    const first = invoke("sessions.files.list", { sessionKey: "agent:main:main" });
    const second = invoke("sessions.files.list", { sessionKey: "agent:main:main" });
    await vi.waitFor(() => expect(hoisted.runGit).toHaveBeenCalledOnce());

    finishProbe({ code: 0, stderr: "", stdout: `${workspaceRoot}\n` });
    const [firstPayload, secondPayload] = await Promise.all([
      first.then(expectOkPayload),
      second.then(expectOkPayload),
    ]);
    expect(firstPayload.gitCheckout).toBe(true);
    expect(secondPayload.gitCheckout).toBe(true);

    hoisted.runGit.mockResolvedValueOnce({ code: 1, stderr: "not a checkout", stdout: "" });
    const freshPayload = expectOkPayload(
      await invoke("sessions.files.list", { sessionKey: "agent:main:main" }),
    );
    expect(freshPayload.gitCheckout).toBe(false);
    expect(hoisted.runGit).toHaveBeenCalledTimes(2);
  });
});
