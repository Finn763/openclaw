// Host-path resolution for task suggestion cwd values recorded inside sandboxes.
import fs from "node:fs";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { mapSandboxContainerWorkspacePath } from "../../agents/sandbox-paths.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import type { SandboxWorkspaceInfo } from "../../agents/sandbox/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

function isExistingHostDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function unavailableTaskSuggestionCwdError(params: {
  cwd: string;
  mappedHostCwd?: string;
  hostWorkspaceDir: string;
  containerWorkdir?: string;
}): ErrorShape {
  const unresolved = params.mappedHostCwd
    ? `${params.cwd} maps to ${params.mappedHostCwd} in the sandbox workspace, but that path is missing on the host`
    : `${params.cwd} is missing on the host`;
  const hint = params.containerWorkdir
    ? `use a host path under ${params.hostWorkspaceDir} or a container path under ${params.containerWorkdir}`
    : `use a host path under ${params.hostWorkspaceDir}`;
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `task suggestion cwd is unavailable: ${unresolved}; sandboxed sessions run in a container, so ${hint}.`,
  );
}

/**
 * Accepting a suggestion creates a host session, so its cwd must resolve on the
 * host. Sandboxed sessions see container paths: translate the container
 * workspace path back to the host sandbox workspace it is bind-mounted from and
 * refuse anything else, instead of recording a cwd that can never resolve.
 */
export async function resolveTaskSuggestionHostCwd(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  cwd: string;
}): Promise<{ ok: true; cwd: string } | { ok: false; error: ErrorShape }> {
  const hostWorkspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  let sandbox: SandboxWorkspaceInfo | null;
  try {
    sandbox = await ensureSandboxWorkspaceForSession({
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      workspaceDir: hostWorkspaceDir,
    });
  } catch {
    // An unresolvable sandbox layout still admits a path the host can resolve
    // on its own; only the recorded-broken case below stays out of reach.
    return isExistingHostDirectory(params.cwd)
      ? { ok: true, cwd: params.cwd }
      : {
          ok: false,
          error: unavailableTaskSuggestionCwdError({ cwd: params.cwd, hostWorkspaceDir }),
        };
  }
  if (!sandbox) {
    // Not a sandboxed session: host cwd semantics are unchanged.
    return { ok: true, cwd: params.cwd };
  }
  const mappedHostCwd = sandbox.containerWorkdir
    ? mapSandboxContainerWorkspacePath({
        candidate: params.cwd,
        sandboxRoot: sandbox.workspaceDir,
        containerWorkdir: sandbox.containerWorkdir,
      })
    : undefined;
  const hostCwd = mappedHostCwd ?? params.cwd;
  if (isExistingHostDirectory(hostCwd)) {
    return { ok: true, cwd: hostCwd };
  }
  return {
    ok: false,
    error: unavailableTaskSuggestionCwdError({
      cwd: params.cwd,
      ...(mappedHostCwd ? { mappedHostCwd } : {}),
      hostWorkspaceDir: sandbox.workspaceDir,
      ...(sandbox.containerWorkdir ? { containerWorkdir: sandbox.containerWorkdir } : {}),
    }),
  };
}
