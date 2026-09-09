/**
 * Sandbox-host exec allowlist/ask enforcement (#141300).
 * Isolated (cron) sessions resolve to host=sandbox, which previously skipped
 * the allowlist/ask guard entirely (fail-open). These tests pin fail-closed:
 * non-allowlisted sandbox commands are denied, allowlisted ones still run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveExecApprovals, type ExecApprovalsFile } from "../infra/exec-approvals.js";
import type { ExecAllowlistEntry } from "../infra/exec-approvals.types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool as createExecToolImpl } from "./bash-tools.exec-run.js";

type ExecToolDefaults = Parameters<typeof createExecToolImpl>[0];

const createExecTool = (defaults?: ExecToolDefaults): ReturnType<typeof createExecToolImpl> =>
  createExecToolImpl({ agentId: "main", ...defaults });

function writeApprovalsFixture(file: Record<string, unknown>): void {
  saveExecApprovals(file as ExecApprovalsFile);
}

function writeAllowlistFixture(allowlist: ExecAllowlistEntry[]): void {
  writeApprovalsFixture({
    version: 1,
    defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
    agents: { "*": { allowlist } },
  });
}

/** Sandbox backend that spawns the current node binary: works on every platform. */
function mockNodeSandboxBackend(marker: string) {
  const buildExecSpec = vi.fn(async () => ({
    argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(marker)})`],
    env: process.env,
    stdinMode: "pipe-closed" as const,
  }));
  const sandbox = {
    containerName: "sandbox-allowlist-guard-test",
    workspaceDir: os.tmpdir(),
    containerWorkdir: "/workspace",
    buildExecSpec,
  };
  return { buildExecSpec, sandbox };
}

describe("sandbox exec allowlist guard (#141300)", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempRoot: string | undefined;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
    ]);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sandbox-allowlist-"));
    setTestEnvValue("HOME", tempRoot);
    setTestEnvValue("USERPROFILE", tempRoot);
    setTestEnvValue("OPENCLAW_HOME", tempRoot);
    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
    if (process.platform === "win32") {
      const parsed = path.parse(tempRoot);
      setTestEnvValue("HOMEDRIVE", parsed.root.slice(0, 2));
      setTestEnvValue("HOMEPATH", tempRoot.slice(2) || "\\");
    } else {
      deleteTestEnvValue("HOMEDRIVE");
      deleteTestEnvValue("HOMEPATH");
    }
    resetProcessRegistryForTests();
  });

  afterEach(() => {
    const dir = tempRoot;
    tempRoot = undefined;
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("denies non-allowlisted sandbox commands when ask is off (fail-closed)", async () => {
    writeAllowlistFixture([{ pattern: "/nonexistent/only-entry" }]);
    const { buildExecSpec, sandbox } = mockNodeSandboxBackend("must-not-run");
    const tool = createExecTool({
      host: "auto",
      security: "allowlist",
      ask: "off",
      safeBins: [],
      sandbox: { ...sandbox, workspaceDir: tempRoot ?? os.tmpdir() },
    });

    await expect(tool.execute("call-sandbox-deny-miss", { command: "whoami" })).rejects.toThrow(
      /exec denied.*allowlist miss/i,
    );
    expect(buildExecSpec).not.toHaveBeenCalled();
  });

  it("denies non-allowlisted sandbox commands when ask is on-miss (no headless approval route)", async () => {
    writeAllowlistFixture([{ pattern: "/nonexistent/only-entry" }]);
    const { buildExecSpec, sandbox } = mockNodeSandboxBackend("must-not-run");
    const tool = createExecTool({
      host: "auto",
      security: "allowlist",
      ask: "on-miss",
      safeBins: [],
      sandbox: { ...sandbox, workspaceDir: tempRoot ?? os.tmpdir() },
    });

    const result = await tool.execute("call-sandbox-deny-ask", { command: "whoami" });
    expect(buildExecSpec).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ status: "failed" });
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).toMatch(/approval_required|exec denied/i);
  });

  it("allows allowlisted sandbox commands when ask is off", async () => {
    writeAllowlistFixture([{ pattern: process.execPath }]);
    const { buildExecSpec, sandbox } = mockNodeSandboxBackend("sandbox-allowlisted-ok");
    const tool = createExecTool({
      host: "auto",
      security: "allowlist",
      ask: "off",
      safeBins: [],
      sandbox: { ...sandbox, workspaceDir: tempRoot ?? os.tmpdir() },
    });

    const result = await tool.execute("call-sandbox-allow-hit", {
      command: `"${process.execPath}" --version`,
    });
    expect(buildExecSpec).toHaveBeenCalledTimes(1);
    expect(result.details.status).toBe("completed");
  });

  it("still runs sandbox commands when security is full (guard is policy-driven, not a blanket deny)", async () => {
    const { buildExecSpec, sandbox } = mockNodeSandboxBackend("sandbox-full-ok");
    const tool = createExecTool({
      host: "auto",
      security: "full",
      ask: "off",
      sandbox: { ...sandbox, workspaceDir: tempRoot ?? os.tmpdir() },
    });

    const result = await tool.execute("call-sandbox-full", { command: "whoami" });
    expect(buildExecSpec).toHaveBeenCalledTimes(1);
    expect(result.details.status).toBe("completed");
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("sandbox-full-ok");
  });
});
