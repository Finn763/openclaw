// Regression tests for code-mode child stderr stream errors in Tool Search.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_TOOL_STDERR_TAIL_BYTES } from "./sessions/tools/limits.js";

type MockSpawnChild = EventEmitter & {
  stderr?: EventEmitter & { setEncoding?: (enc: string) => void };
  send?: (message: unknown, callback?: (error?: Error | null) => void) => boolean;
  connected?: boolean;
  kill?: (signal?: string) => void;
};

function createMockSpawnChild() {
  const child = new EventEmitter() as MockSpawnChild;
  const stderr = new EventEmitter() as MockSpawnChild["stderr"];
  stderr!.setEncoding = vi.fn();
  child.stderr = stderr;
  child.connected = true;
  child.kill = vi.fn();
  child.send = vi.fn(() => true);
  return { child, stderr };
}

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  const spawnLocal = vi.fn(
    (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
      const { child } = createMockSpawnChild();
      return child as unknown as ChildProcess;
    },
  );
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: spawnLocal as unknown as typeof import("node:child_process").spawn,
    },
  );
});

const spawnMock = vi.mocked(spawn);

let toolSearch: typeof import("./tool-search.js");
let testing: (typeof import("./tool-search.test-support.js"))["testing"];

describe("tool-search code-mode stream errors", () => {
  beforeAll(async () => {
    toolSearch = await import("./tool-search.js");
    testing = (await import("./tool-search.test-support.js")).testing;
  });

  afterEach(() => {
    testing.setToolSearchCodeModeSupportedForTest(undefined);
    testing.setToolSearchMinCodeTimeoutMsForTest(undefined);
  });

  it("rejects stderr errors and leaves the unused stdout unpiped", async () => {
    testing.setToolSearchCodeModeSupportedForTest(true);
    testing.setToolSearchMinCodeTimeoutMsForTest(1000);

    let spawnedChild: MockSpawnChild | undefined;
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stderr } = createMockSpawnChild();
        spawnedChild = child;
        process.nextTick(() => {
          stderr?.emit("error", new Error("stderr read failed"));
        });
        return child as unknown as ChildProcess;
      },
    );

    const runtime = new toolSearch.ToolSearchRuntime({}, toolSearch.resolveToolSearchConfig({}));

    await expect(
      testing.runCodeModeChild({
        code: "return 1;",
        config: toolSearch.resolveToolSearchConfig({}),
        logs: [],
        parentToolCallId: "call-stderr-error",
        runtime,
      }),
    ).rejects.toThrow("stderr read failed");
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    expect(spawnedChild?.kill).toHaveBeenCalledOnce();
  });

  it("keeps stderr tail in exit error messages valid at UTF-16 boundaries", async () => {
    testing.setToolSearchCodeModeSupportedForTest(true);
    testing.setToolSearchMinCodeTimeoutMsForTest(1000);

    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stderr } = createMockSpawnChild();
        process.nextTick(() => {
          stderr?.emit("data", `${"a".repeat(500)}😀${"a".repeat(499)}`);
          process.nextTick(() => {
            child.emit("exit", 1, null);
          });
        });
        return child as unknown as ChildProcess;
      },
    );

    const runtime = new toolSearch.ToolSearchRuntime({}, toolSearch.resolveToolSearchConfig({}));

    let caught: Error | undefined;
    try {
      await testing.runCodeModeChild({
        code: "return 1;",
        config: toolSearch.resolveToolSearchConfig({}),
        logs: [],
        parentToolCallId: "call-stderr-utf16",
        runtime,
      });
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/tool_search_code child exited with 1/);
    expect(caught?.message).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(caught?.message.endsWith("a".repeat(499))).toBe(true);
  });

  it("discloses discarded stderr bytes when the code-mode tail truncates", async () => {
    testing.setToolSearchCodeModeSupportedForTest(true);
    testing.setToolSearchMinCodeTimeoutMsForTest(1000);

    const chunk = `HEAD_OVERFLOW_${"x".repeat(SESSION_TOOL_STDERR_TAIL_BYTES + 1_000)}TAIL`;
    const droppedBytes = Buffer.byteLength(chunk, "utf8") - SESSION_TOOL_STDERR_TAIL_BYTES;
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stderr } = createMockSpawnChild();
        process.nextTick(() => {
          stderr?.emit("data", chunk);
          process.nextTick(() => {
            child.emit("exit", 1, null);
          });
        });
        return child as unknown as ChildProcess;
      },
    );

    const runtime = new toolSearch.ToolSearchRuntime({}, toolSearch.resolveToolSearchConfig({}));

    let caught: Error | undefined;
    try {
      await testing.runCodeModeChild({
        code: "return 1;",
        config: toolSearch.resolveToolSearchConfig({}),
        logs: [],
        parentToolCallId: "call-stderr-tail-disclosure",
        runtime,
      });
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/tool_search_code child exited with 1/);
    expect(caught?.message).not.toContain("HEAD_OVERFLOW_");
    expect(caught?.message).toContain("TAIL");
    expect(caught?.message).toContain(
      `[${droppedBytes} bytes of earlier stderr output were discarded at the 64 KiB retention cap and cannot be recovered]`,
    );
  });

  it("omits the truncation disclosure when child stderr fits the tail cap", async () => {
    testing.setToolSearchCodeModeSupportedForTest(true);
    testing.setToolSearchMinCodeTimeoutMsForTest(1000);

    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stderr } = createMockSpawnChild();
        process.nextTick(() => {
          stderr?.emit("data", "short stderr note");
          process.nextTick(() => {
            child.emit("exit", 1, null);
          });
        });
        return child as unknown as ChildProcess;
      },
    );

    const runtime = new toolSearch.ToolSearchRuntime({}, toolSearch.resolveToolSearchConfig({}));

    let caught: Error | undefined;
    try {
      await testing.runCodeModeChild({
        code: "return 1;",
        config: toolSearch.resolveToolSearchConfig({}),
        logs: [],
        parentToolCallId: "call-stderr-tail-no-truncation",
        runtime,
      });
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/tool_search_code child exited with 1/);
    expect(caught?.message).toContain("short stderr note");
    expect(caught?.message).not.toMatch(/discarded at the 64 KiB retention cap/);
  });
});
