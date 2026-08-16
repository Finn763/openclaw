import { describe, expect, it, vi } from "vitest";
import { listLocalTuiProcesses, terminateLocalTuiProcesses } from "./local-tui-processes.js";

describe("local TUI processes", () => {
  it("lists only verified local TUI processes from ps output", () => {
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: [
        " 101 openclaw-tui",
        " 101 openclaw-tui",
        " 102 /usr/bin/node /usr/lib/node_modules/openclaw/dist/index.js gateway --port 18789",
        " 104 openclaw tui --local",
        " 105 /usr/bin/openclaw chat",
        " 106 /usr/bin/node /usr/lib/node_modules/openclaw/openclaw.mjs tui",
        " 107 helper --note 'openclaw tui'",
        " 108 openclaw-helper openclaw terminal",
        " 109 openclaw --flag tui",
        " 999 openclaw tui",
      ].join("\n"),
    });

    expect(
      listLocalTuiProcesses({
        platform: "darwin",
        currentPid: 999,
        spawnSync,
      }),
    ).toEqual([
      { pid: 101, command: "openclaw-tui" },
      { pid: 104, command: "openclaw tui --local" },
      { pid: 105, command: "/usr/bin/openclaw chat" },
      {
        pid: 106,
        command: "/usr/bin/node /usr/lib/node_modules/openclaw/openclaw.mjs tui",
      },
    ]);
    expect(spawnSync).toHaveBeenCalledWith("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 1_000,
    });
  });

  it("skips process probing on Windows", () => {
    const spawnSync = vi.fn();

    expect(listLocalTuiProcesses({ platform: "win32", spawnSync })).toEqual([]);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("terminates stale local TUI processes with a kill fallback", async () => {
    const alive = new Set([101]);
    const signals: Array<[number, string | number]> = [];
    const controller = {
      kill: vi.fn((pid: number, signal: string | number) => {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") {
          alive.delete(pid);
          return true;
        }
        if (signal === 0) {
          if (alive.has(pid)) {
            return true;
          }
          throw new Error("gone");
        }
        return true;
      }),
    };

    await expect(
      terminateLocalTuiProcesses({
        processes: [{ pid: 101, command: "openclaw-tui" }],
        controller,
        graceMs: 0,
      }),
    ).resolves.toEqual({ stopped: [101], failed: [] });
    expect(signals).toEqual([
      [101, "SIGTERM"],
      [101, 0],
      [101, "SIGKILL"],
      [101, 0],
    ]);
  });

  it("reports local TUI processes that survive the kill fallback", async () => {
    const controller = {
      kill: vi.fn(() => true),
    };

    await expect(
      terminateLocalTuiProcesses({
        processes: [{ pid: 101, command: "openclaw-tui" }],
        controller,
        graceMs: 0,
      }),
    ).resolves.toEqual({ stopped: [], failed: [101] });
  });
});
