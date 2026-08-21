import { describe, expect, it, vi } from "vitest";
import {
  listLocalTuiProcesses,
  quiesceLocalTuiProcessesBeforeUpdate,
  resolveLocalTuiUpdateLockPath,
  terminateLocalTuiProcesses,
  waitForLocalTuiUpdate,
} from "./local-tui-processes.js";

describe("local TUI processes", () => {
  it("scopes the update gate to the invoking user's home", () => {
    expect(resolveLocalTuiUpdateLockPath("/home/alice")).not.toBe(
      resolveLocalTuiUpdateLockPath("/home/bob"),
    );
  });

  it("lists only verified local TUI processes from ps output", () => {
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: [
        " 501 101 Thu Aug 20 19:00:00 2026 openclaw-tui",
        " 501 101 Thu Aug 20 19:00:00 2026 openclaw-tui",
        " 501 102 Thu Aug 20 19:00:00 2026 /usr/bin/node /usr/lib/node_modules/openclaw/dist/index.js gateway --port 18789",
        " 501 104 Thu Aug 20 19:00:00 2026 openclaw tui --local",
        " 501 105 Thu Aug 20 19:00:00 2026 /usr/bin/openclaw chat",
        " 501 106 Thu Aug 20 19:00:00 2026 /usr/bin/node /usr/lib/node_modules/openclaw/openclaw.mjs tui",
        " 501 107 Thu Aug 20 19:00:00 2026 helper --note 'openclaw tui'",
        " 501 108 Thu Aug 20 19:00:00 2026 openclaw-helper openclaw terminal",
        " 501 109 Thu Aug 20 19:00:00 2026 openclaw --flag tui",
        " 501 110 Thu Aug 20 19:00:00 2026 openclaw --profile work tui --local",
        " 501 111 Thu Aug 20 19:00:00 2026 /usr/bin/node /usr/lib/node_modules/openclaw/openclaw.mjs --no-color terminal",
        " 501 112 Thu Aug 20 19:00:00 2026 openclaw --profile=work chat",
        " 501 114 Thu Aug 20 19:00:00 2026 openclaw",
        " 501 115 Thu Aug 20 19:00:00 2026 openclaw --profile work",
        " 501 116 Thu Aug 20 19:00:00 2026 /usr/bin/node /usr/lib/node_modules/openclaw/openclaw.mjs --no-color",
        " 502 113 Thu Aug 20 19:00:00 2026 openclaw tui",
        " 501 999 Thu Aug 20 19:00:00 2026 openclaw tui",
      ].join("\n"),
    });

    expect(
      listLocalTuiProcesses({
        platform: "darwin",
        currentUid: 501,
        currentPid: 999,
        spawnSync,
      }),
    ).toEqual([
      { pid: 101, command: "openclaw-tui", startTime: "Thu Aug 20 19:00:00 2026" },
      {
        pid: 104,
        command: "openclaw tui --local",
        startTime: "Thu Aug 20 19:00:00 2026",
      },
      {
        pid: 105,
        command: "/usr/bin/openclaw chat",
        startTime: "Thu Aug 20 19:00:00 2026",
      },
      {
        pid: 106,
        command: "/usr/bin/node /usr/lib/node_modules/openclaw/openclaw.mjs tui",
        startTime: "Thu Aug 20 19:00:00 2026",
      },
      {
        pid: 110,
        command: "openclaw --profile work tui --local",
        startTime: "Thu Aug 20 19:00:00 2026",
      },
      {
        pid: 111,
        command: "/usr/bin/node /usr/lib/node_modules/openclaw/openclaw.mjs --no-color terminal",
        startTime: "Thu Aug 20 19:00:00 2026",
      },
      {
        pid: 112,
        command: "openclaw --profile=work chat",
        startTime: "Thu Aug 20 19:00:00 2026",
      },
      { pid: 114, command: "openclaw", startTime: "Thu Aug 20 19:00:00 2026" },
      {
        pid: 115,
        command: "openclaw --profile work",
        startTime: "Thu Aug 20 19:00:00 2026",
      },
      {
        pid: 116,
        command: "/usr/bin/node /usr/lib/node_modules/openclaw/openclaw.mjs --no-color",
        startTime: "Thu Aug 20 19:00:00 2026",
      },
    ]);
    expect(spawnSync).toHaveBeenCalledWith("ps", ["-axo", "uid=,pid=,lstart=,command="], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 1_000,
    });
  });

  it("lists verified TUI processes on Windows", () => {
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        { ProcessId: 101, CommandLine: "C:\\openclaw.exe tui", OwnerSid: "S-1", CurrentSid: "S-1" },
        {
          ProcessId: 102,
          CommandLine: "C:\\openclaw.exe gateway",
          OwnerSid: "S-1",
          CurrentSid: "S-1",
        },
        {
          ProcessId: 103,
          CommandLine: '"C:\\Program Files\\OpenClaw\\openclaw.exe" chat',
          OwnerSid: "S-1",
          CurrentSid: "S-1",
        },
        {
          ProcessId: 104,
          CommandLine:
            '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\OpenClaw\\openclaw.mjs" terminal',
          OwnerSid: "S-1",
          CurrentSid: "S-1",
        },
        { ProcessId: 105, CommandLine: "C:\\openclaw.exe tui", OwnerSid: "S-2", CurrentSid: "S-1" },
        { ProcessId: 106, CommandLine: "C:\\openclaw.exe tui", OwnerSid: null, CurrentSid: "S-1" },
      ]),
    });

    expect(
      listLocalTuiProcesses({
        platform: "win32",
        currentPid: 999,
        spawnSync,
        readWindowsStartTime: () => 123,
      }),
    ).toEqual([
      { pid: 101, command: "C:\\openclaw.exe tui", startTime: "123" },
      {
        pid: 103,
        command: '"C:\\Program Files\\OpenClaw\\openclaw.exe" chat',
        startTime: "123",
      },
      {
        pid: 104,
        command:
          '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\OpenClaw\\openclaw.mjs" terminal',
        startTime: "123",
      },
    ]);
    expect(spawnSync).toHaveBeenCalledOnce();
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
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        return true;
      }),
    };

    await expect(
      terminateLocalTuiProcesses({
        processes: [{ pid: 101, command: "openclaw-tui", startTime: "start" }],
        controller,
        graceMs: 0,
        killGraceMs: 0,
        readStartTime: () => "start",
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
        processes: [{ pid: 101, command: "openclaw-tui", startTime: "start" }],
        controller,
        graceMs: 0,
        killGraceMs: 0,
        readStartTime: () => "start",
      }),
    ).resolves.toEqual({ stopped: [], failed: [101] });
  });

  it("fails closed when a live process identity can no longer be read", async () => {
    const controller = { kill: vi.fn(() => true) };
    let reads = 0;

    await expect(
      terminateLocalTuiProcesses({
        processes: [{ pid: 101, command: "openclaw-tui", startTime: "start" }],
        controller,
        graceMs: 0,
        killGraceMs: 0,
        readStartTime: () => (++reads === 1 ? "start" : undefined),
      }),
    ).resolves.toEqual({ stopped: [], failed: [101] });
    expect(controller.kill).not.toHaveBeenCalledWith(101, "SIGKILL");
  });

  it("refuses shared update mutation when a matched client survives", async () => {
    const processes = [{ pid: 101, command: "openclaw --profile work tui" }];

    await expect(
      quiesceLocalTuiProcessesBeforeUpdate({
        list: () => processes,
        terminate: async () => ({ stopped: [], failed: [101] }),
      }),
    ).rejects.toThrow(
      "Update refused: could not stop local TUI clients 101. Close them and retry the update.",
    );
  });

  it("holds the startup gate after discovery until the update owner releases it", async () => {
    const release = vi.fn(async () => {});
    const lock = await quiesceLocalTuiProcessesBeforeUpdate({
      list: () => [],
      acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
    });

    expect(release).not.toHaveBeenCalled();
    await lock?.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it("waits for the update gate before TUI startup", async () => {
    const release = vi.fn(async () => {});
    await waitForLocalTuiUpdate(vi.fn(async () => ({ lockPath: "test", release })));
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps waiting after the bounded lock attempt while an update is still running", async () => {
    const release = vi.fn(async () => {});
    const timeout = Object.assign(new Error("busy"), { code: "file_lock_timeout" });
    const acquireLock = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ lockPath: "test", release });

    await waitForLocalTuiUpdate(acquireLock);

    expect(acquireLock).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });
});
