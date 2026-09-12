// Host-path resolution for task suggestion cwd values recorded inside sandboxes.
import fs from "node:fs";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import {
  buildSandboxFsMounts,
  resolveSandboxFsPathWithMounts,
} from "../../agents/sandbox/fs-paths.js";
import type { SandboxWorkspaceInfo } from "../../agents/sandbox/types.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";

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
 * Source-session facts the live run already knows: the workspace sandbox
 * setup mounts, plus the skill snapshot it resolves the sandbox with.
 * Nonempty library selections pick a separate isolation subject and
 * workspace, so resolving without them points /workspace at the wrong tree.
 */
function resolveSourceSessionFacts(params: { sessionKey: string; agentId: string }): {
  workspaceDir?: string;
  skillsSnapshot?: SkillSnapshot;
} {
  try {
    const entry = loadGatewaySessionEntryReadOnly(params.sessionKey, {
      agentId: params.agentId,
    }).entry;
    const workspaceDir = resolveIngressWorkspaceOverrideForSessionRun({
      spawnedBy: entry?.spawnedBy,
      workspaceDir: entry?.spawnedWorkspaceDir,
      cwd: entry?.spawnedCwd,
    });
    const skillsSnapshot = entry?.skillsSnapshot;
    return {
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(skillsSnapshot?.librarySelections?.length ? { skillsSnapshot } : {}),
    };
  } catch {
    // An unreadable store leaves the configured agent workspace in charge.
    return {};
  }
}

/**
 * Map a recorded cwd onto the host directory the sandbox mounts there. The
 * mount table owns precedence (nested binds beat the workspace root) and
 * containment, so a path outside every mount stays unresolved instead of being
 * guessed from a container prefix.
 */
function mapCwdThroughSandboxMounts(params: {
  sandbox: SandboxWorkspaceInfo;
  containerWorkdir: string;
  cwd: string;
}): string | undefined {
  const mounts = buildSandboxFsMounts({
    workspaceDir: params.sandbox.workspaceDir,
    agentWorkspaceDir: params.sandbox.agentWorkspaceDir ?? params.sandbox.workspaceDir,
    ...(params.sandbox.skillsWorkspaceDir
      ? { skillsWorkspaceDir: params.sandbox.skillsWorkspaceDir }
      : {}),
    ...(params.sandbox.readOnlyResourceMounts
      ? { readOnlyResourceMounts: params.sandbox.readOnlyResourceMounts }
      : {}),
    workspaceAccess: params.sandbox.workspaceAccess ?? "ro",
    containerName: "",
    containerWorkdir: params.containerWorkdir,
    docker: params.sandbox.dockerBinds ? { binds: [...params.sandbox.dockerBinds] } : {},
  });
  try {
    return resolveSandboxFsPathWithMounts({
      filePath: params.cwd,
      cwd: params.containerWorkdir,
      defaultWorkspaceRoot: params.sandbox.workspaceDir,
      defaultContainerRoot: params.containerWorkdir,
      mounts,
    }).hostPath;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the host directory a recorded cwd refers to. Sandboxed sessions see
 * container paths, so translate through the source session's effective
 * workspace and mounts; every other session keeps host cwd semantics.
 *
 * Callers choose the policy: acceptance that starts a host session refuses what
 * does not resolve, while task suggestion creation keeps the recorded path so
 * "start in this session" stays available.
 */
export async function resolveTaskSuggestionHostCwd(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  cwd: string;
  /**
   * Acceptance re-resolves the cwd creation already translated to the host.
   * Preserve that host identity for existing directories so overlapping
   * container prefixes cannot translate it a second time.
   */
  cwdAlreadyHostResolved?: boolean;
}): Promise<{ ok: true; cwd: string } | { ok: false; error: ErrorShape }> {
  const sourceFacts = resolveSourceSessionFacts(params);
  const hostWorkspaceDir =
    sourceFacts.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, params.agentId);
  if (params.cwdAlreadyHostResolved) {
    // A host path creation already resolved stays terminal: re-translating it
    // through container mounts could select a different existing directory
    // when the original target disappears.
    return isExistingHostDirectory(params.cwd)
      ? { ok: true, cwd: params.cwd }
      : {
          ok: false,
          error: unavailableTaskSuggestionCwdError({ cwd: params.cwd, hostWorkspaceDir }),
        };
  }
  let sandbox: SandboxWorkspaceInfo | null;
  try {
    sandbox = await ensureSandboxWorkspaceForSession({
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      workspaceDir: hostWorkspaceDir,
      ...(sourceFacts.skillsSnapshot ? { skillsSnapshot: sourceFacts.skillsSnapshot } : {}),
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
  const mappedHostCwd =
    sandbox.containerWorkdir && hasLocalSandboxMountContract(params.cfg, params.agentId)
      ? mapCwdThroughSandboxMounts({
          sandbox,
          containerWorkdir: sandbox.containerWorkdir,
          cwd: params.cwd,
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

/**
 * Only local-container backends mount host directories into the sandbox, so
 * only their container paths may be translated back. Remote (ssh) backends own
 * a separately seeded remote workspace, and custom backends declare no local
 * mount contract here; mapping their workdir would select stale local files.
 * Source-session execution never reaches this mapping (it bypasses host
 * resolution), so skipping it only turns invented host paths into honest
 * unavailable-cwd errors at acceptance.
 */
// ponytail: allowlist, not capability probing — custom local-mount backends
// need an explicit entry here once they exist.
function hasLocalSandboxMountContract(cfg: OpenClawConfig, agentId: string): boolean {
  const backend = resolveSandboxConfigForAgent(cfg, agentId).backend;
  return backend === "docker" || backend === "podman";
}
