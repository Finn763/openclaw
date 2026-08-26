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
            // Real stdio streams always reach 'close' after process exit;
            // failure rendering now waits for that drain point.
            process.nextTick(() => {
              stderr?.emit("close");
            });
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
            // Real stdio streams always reach 'close' after process exit;
            // failure rendering now waits for that drain point.
            process.nextTick(() => {
              stderr?.emit("close");
            });
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

  it("accounts for stderr chunks emitted after exit but before stream close", async () => {
    testing.setToolSearchCodeModeSupportedForTest(true);
    testing.setToolSearchMinCodeTimeoutMsForTest(1000);

    // Reproduces the real-world ordering where a child flushes its final
    // oversized stderr chunk AFTER the process has already reported exit but
    // BEFORE the stderr stream closes. The loss notice must not be rendered
    // at 'exit' time or this trailing chunk is silently lost.
    const earlyChunk = "early ";
    const lateChunk = `${"x".repeat(SESSION_TOOL_STDERR_TAIL_BYTES + 400)}LATE_END`;
    const expectedDropped =
      Buffer.byteLength(`${earlyChunk}${lateChunk}`, "utf8") - SESSION_TOOL_STDERR_TAIL_BYTES;

    let sawStderrClose = false;
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stderr } = createMockSpawnChild();
        stderr?.once("close", () => {
          sawStderrClose = true;
        });
        process.nextTick(() => {
          stderr?.emit("data", earlyChunk);
          process.nextTick(() => {
            child.emit("exit", 1, null);
            process.nextTick(() => {
              stderr?.emit("data", lateChunk);
              process.nextTick(() => {
                stderr?.emit("close");
              });
            });
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
        parentToolCallId: "call-stderr-after-exit-chunk",
        runtime,
      });
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }

    expect(sawStderrClose).toBe(true);
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/tool_search_code child exited with 1/);
    expect(caught?.message).toContain("LATE_END");
    expect(caught?.message).not.toContain("early ");
    expect(caught?.message).toContain(
      `[${expectedDropped} bytes of earlier stderr output were discarded at the 64 KiB retention cap and cannot be recovered]`,
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
            // Real stdio streams always reach 'close' after process exit;
            // failure rendering now waits for that drain point.
            process.nextTick(() => {
              stderr?.emit("close");
            });
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

  it("resolves a clean exit whose stderr closed before the final IPC result arrives", async () => {
    testing.setToolSearchCodeModeSupportedForTest(true);
    testing.setToolSearchMinCodeTimeoutMsForTest(1000);

    // Real-world ordering: the child exits cleanly, its stderr stream closes
    // right after, and only then does the final IPC result land inside the
    // parent's clean-exit grace window. The stderr close must not cut that
    // window short and reject with "child exited with 0".
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stderr } = createMockSpawnChild();
        process.nextTick(() => {
          child.emit("exit", 0, null);
          process.nextTick(() => {
            stderr?.emit("close");
            process.nextTick(() => {
              child.emit("message", { type: "result", ok: true, value: 42 });
            });
          });
        });
        return child as unknown as ChildProcess;
      },
    );

    const runtime = new toolSearch.ToolSearchRuntime({}, toolSearch.resolveToolSearchConfig({}));

    await expect(
      testing.runCodeModeChild({
        code: "return 42;",
        config: toolSearch.resolveToolSearchConfig({}),
        logs: [],
        parentToolCallId: "call-clean-exit-stderr-close-late-result",
        runtime,
      }),
    ).resolves.toBe(42);
  });

  it("resolves when stderr closes before a clean exit and the final IPC result arrives", async () => {
    testing.setToolSearchCodeModeSupportedForTest(true);
    testing.setToolSearchMinCodeTimeoutMsForTest(1000);

    // Inverse ordering: stderr reaches 'close' while no exit status exists yet.
    // Close-triggered rendering must stay inert until exit proves failure;
    // a subsequent clean exit still resolves from its late IPC result.
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stderr } = createMockSpawnChild();
        process.nextTick(() => {
          stderr?.emit("close");
          process.nextTick(() => {
            child.emit("exit", 0, null);
            process.nextTick(() => {
              child.emit("message", { type: "result", ok: true, value: 43 });
            });
          });
        });
        return child as unknown as ChildProcess;
      },
    );

    const runtime = new toolSearch.ToolSearchRuntime({}, toolSearch.resolveToolSearchConfig({}));

    await expect(
      testing.runCodeModeChild({
        code: "return 43;",
        config: toolSearch.resolveToolSearchConfig({}),
        logs: [],
        parentToolCallId: "call-stderr-close-before-clean-exit-late-result",
        runtime,
      }),
    ).resolves.toBe(43);
  });

  it("still rejects a clean exit after the IPC grace window when no result arrives", async () => {
    testing.setToolSearchCodeModeSupportedForTest(true);
    testing.setToolSearchMinCodeTimeoutMsForTest(1000);

    // Gating close-triggered finalization to nonzero/signaled exits must not
    // swallow genuinely result-less children: the clean-exit grace timer is
    // still the last-resort race breaker that reports "exited with 0".
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stderr } = createMockSpawnChild();
        process.nextTick(() => {
          child.emit("exit", 0, null);
          process.nextTick(() => {
            stderr?.emit("close");
          });
        });
        return child as unknown as ChildProcess;
      },
    );

    const runtime = new toolSearch.ToolSearchRuntime({}, toolSearch.resolveToolSearchConfig({}));

    await expect(
      testing.runCodeModeChild({
        code: "return null;",
        config: toolSearch.resolveToolSearchConfig({}),
        logs: [],
        parentToolCallId: "call-clean-exit-grace-expiry",
        runtime,
      }),
    ).rejects.toThrow(/tool_search_code child exited with 0/);
  });
});
