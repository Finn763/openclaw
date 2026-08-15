import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import path from "node:path";
import { sleep } from "../utils/sleep.js";

export type LocalTuiProcess = {
  pid: number;
  command: string;
};

type ProcessSignal = "SIGTERM" | "SIGKILL";

type ProcessController = {
  kill: (pid: number, signal: ProcessSignal | 0) => boolean;
};

type PsResult = {
  error?: Error;
  status: number | null;
  stdout?: string;
};

const LOCAL_TUI_SUBCOMMANDS = new Set(["chat", "terminal", "tui"]);
const LOCAL_TUI_PROCESS_PROBE_TIMEOUT_MS = 1_000;

function tokenizeCommandLine(command: string): string[] {
  return command.trim().split(/\s+/u).filter(Boolean);
}

function normalizeExecutableName(value: string | undefined): string {
  return path.basename(value ?? "").replace(/\.exe$/iu, "");
}

export function isLocalTuiCommand(command: string): boolean {
  const argv = tokenizeCommandLine(command);
  const executable = normalizeExecutableName(argv[0]);
  if (executable === "openclaw-tui") {
    return true;
  }
  return executable === "openclaw" && LOCAL_TUI_SUBCOMMANDS.has(argv[1] ?? "");
}

export function parseLocalTuiProcessLine(line: string, currentPid = process.pid) {
  const match = line.match(/^\s*(\d+)\s+(.+)$/);
  if (!match) {
    return null;
  }
  const pid = Number(match[1]);
  if (!Number.isFinite(pid) || pid <= 0 || pid === currentPid) {
    return null;
  }
  const command = match[2]?.trim() ?? "";
  if (!isLocalTuiCommand(command)) {
    return null;
  }
  return { pid, command };
}

/** Lists local OpenClaw TUI processes whose in-memory chunk graph may outlive an update. */
export function listLocalTuiProcesses(
  params: {
    platform?: NodeJS.Platform;
    currentPid?: number;
    spawnSync?: (
      command: string,
      args: string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ) => PsResult;
  } = {},
): LocalTuiProcess[] {
  if ((params.platform ?? process.platform) === "win32") {
    return [];
  }
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  const ps = spawnSyncImpl("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: LOCAL_TUI_PROCESS_PROBE_TIMEOUT_MS,
  });
  if (ps.error || ps.status !== 0 || typeof ps.stdout !== "string") {
    return [];
  }
  const seen = new Set<number>();
  const processes: LocalTuiProcess[] = [];
  for (const line of ps.stdout.split(/\r?\n/)) {
    const proc = parseLocalTuiProcessLine(line, params.currentPid);
    if (!proc || seen.has(proc.pid)) {
      continue;
    }
    seen.add(proc.pid);
    processes.push(proc);
  }
  return processes;
}

function isProcessAlive(controller: ProcessController, pid: number): boolean {
  try {
    controller.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Terminates local TUI processes with SIGTERM, then SIGKILL for remaining pids. */
export async function terminateLocalTuiProcesses(params: {
  processes: LocalTuiProcess[];
  controller?: ProcessController;
  graceMs?: number;
}): Promise<{ stopped: number[]; failed: number[] }> {
  const controller = params.controller ?? process;
  const graceMs = Math.max(0, params.graceMs ?? 500);
  const stopped: number[] = [];
  const failed: number[] = [];

  for (const proc of params.processes) {
    try {
      controller.kill(proc.pid, "SIGTERM");
    } catch {
      // Already gone is success for this repair.
    }
  }
  if (graceMs > 0) {
    await sleep(graceMs);
  }
  for (const proc of params.processes) {
    if (!isProcessAlive(controller, proc.pid)) {
      stopped.push(proc.pid);
      continue;
    }
    try {
      controller.kill(proc.pid, "SIGKILL");
    } catch {
      // Already gone is still success.
    }
    if (isProcessAlive(controller, proc.pid)) {
      failed.push(proc.pid);
    } else {
      stopped.push(proc.pid);
    }
  }
  return { stopped, failed };
}

export function formatLocalTuiPidList(processes: readonly LocalTuiProcess[]) {
  return processes.map((proc) => String(proc.pid)).join(", ");
}
