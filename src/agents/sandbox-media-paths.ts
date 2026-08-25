/**
 * Sandbox media path resolution helpers.
 *
 * Bridges media references through sandbox filesystems while enforcing workspace-only boundaries when required.
 */
import path from "node:path";
import { safeFileURLToPath } from "../infra/local-file-access.js";
import { createBoundedOutboundMediaReadFile } from "../media/bounded-read-file.js";
import type { OutboundMediaReadFile } from "../media/load-options.js";
import { resolveMediaReferenceSandboxPath } from "../media/media-reference.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import type { SandboxFsBridge, SandboxResolvedPath } from "./sandbox/fs-bridge.js";
import { isPathInsideContainerRoot, normalizeContainerPathCore } from "./sandbox/path-utils.js";

export type SandboxedBridgeMediaPathConfig = {
  root: string;
  bridge: SandboxFsBridge;
  workspaceOnly?: boolean;
};

export function createSandboxBridgeReadFile(params: {
  sandbox: Pick<SandboxedBridgeMediaPathConfig, "root" | "bridge">;
}): OutboundMediaReadFile {
  return createBoundedOutboundMediaReadFile(
    async (filePath, options) =>
      await params.sandbox.bridge.readFile({
        filePath,
        cwd: params.sandbox.root,
        maxBytes: options?.maxBytes,
      }),
  );
}

const BARE_HANDLE_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

/** Returns true for a single-segment, scheme-less relative reference (e.g. `file_<id>`). */
function isBareUploadHandleCandidate(filePath: string): boolean {
  const trimmed = filePath.trim();
  return (
    Boolean(trimmed) &&
    trimmed !== "." &&
    trimmed !== ".." &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    !trimmed.includes("\0") &&
    !path.isAbsolute(trimmed) &&
    !path.posix.isAbsolute(trimmed) &&
    !path.win32.isAbsolute(trimmed) &&
    !BARE_HANDLE_SCHEME_PATTERN.test(trimmed)
  );
}

/**
 * Maps a bare upload handle to its verified staged inbound asset when the
 * workspace-relative target is absent.
 *
 * Upload staging copies inbound media into `media/inbound/*` inside the
 * sandbox workspace; canonical `media://inbound/<id>` references are rewritten
 * upstream, but bare handles (e.g. `file_<id>`) previously resolved against
 * the sandbox root and read ENOENT. Resolution stays bounded: only
 * single-segment, scheme-less relative references qualify, the staged asset
 * must be a regular file under the sandbox inbound dir, and the resulting path
 * still passes the workspace boundary guard.
 *
 * The direct target stays authoritative. The fallback engages only when the
 * bridge stat reports it absent (null); an existing-but-unreadable direct file
 * surfaces its original stat error instead of being silently replaced by the
 * inbound twin.
 */
async function resolveBareStagedUploadHandle(params: {
  sandbox: SandboxedBridgeMediaPathConfig;
  filePath: string;
  inboundFallbackDir?: string;
  enforceWorkspaceBoundary: (resolved: SandboxResolvedPath) => Promise<void>;
}): Promise<{ resolved: string; rewrittenFrom?: string } | null> {
  const fallbackDir = params.inboundFallbackDir?.trim();
  if (!fallbackDir || !isBareUploadHandleCandidate(params.filePath)) {
    return null;
  }
  const handle = params.filePath;
  // Keep existing workspace-relative references authoritative: only fall back
  // when the direct target is absent (ENOENT -> null). Stat failures mean the
  // target exists but cannot be inspected; they propagate as-is.
  const directStat = await params.sandbox.bridge.stat({
    filePath: handle,
    cwd: params.sandbox.root,
  });
  if (directStat) {
    return null;
  }
  const stagedPath = path.posix.join(fallbackDir.replace(/\\/g, "/"), handle);
  const stagedStat = await params.sandbox.bridge
    .stat({ filePath: stagedPath, cwd: params.sandbox.root })
    .catch(() => null);
  if (!stagedStat || stagedStat.type !== "file") {
    return null;
  }
  const resolvedFallback = params.sandbox.bridge.resolvePath({
    filePath: stagedPath,
    cwd: params.sandbox.root,
  });
  await params.enforceWorkspaceBoundary(resolvedFallback);
  return {
    resolved: resolvedFallback.hostPath ?? resolvedFallback.containerPath,
    rewrittenFrom: handle,
  };
}

export async function resolveSandboxedBridgeMediaPath(params: {
  sandbox: SandboxedBridgeMediaPathConfig;
  mediaPath: string;
  inboundFallbackDir?: string;
}): Promise<{ resolved: string; rewrittenFrom?: string }> {
  const mediaPathInfo = params.inboundFallbackDir
    ? resolveMediaReferenceSandboxPath(params.mediaPath, params.inboundFallbackDir)
    : { resolved: params.mediaPath };
  const filePath = /^file:/iu.test(mediaPathInfo.resolved)
    ? safeFileURLToPath(mediaPathInfo.resolved, "linux")
    : mediaPathInfo.resolved;
  const rewrittenFrom = mediaPathInfo.rewrittenFrom;
  if (rewrittenFrom) {
    const stat = await params.sandbox.bridge.stat({
      filePath,
      cwd: params.sandbox.root,
    });
    if (!stat) {
      throw new Error(`Sandbox media reference is not staged: ${rewrittenFrom}`);
    }
  }
  const enforceWorkspaceBoundary = async (resolved: SandboxResolvedPath) => {
    if (!params.sandbox.workspaceOnly) {
      return;
    }
    if (resolved.hostPath) {
      await assertSandboxPath({
        filePath: resolved.hostPath,
        cwd: params.sandbox.root,
        root: params.sandbox.root,
      });
      return;
    }
    const workspaceRoot = params.sandbox.bridge.resolvePath({
      filePath: params.sandbox.root,
      cwd: params.sandbox.root,
    });
    if (
      !isPathInsideContainerRoot(
        normalizeContainerPathCore(workspaceRoot.containerPath),
        normalizeContainerPathCore(resolved.containerPath),
      )
    ) {
      throw new Error(`Sandbox path escapes workspace root: ${resolved.containerPath}`);
    }
  };

  const resolveDirect = () =>
    params.sandbox.bridge.resolvePath({
      filePath,
      cwd: params.sandbox.root,
    });
  if (!rewrittenFrom) {
    // Probe outside the direct-resolution try: a stat failure on an
    // existing-but-unreadable direct target must surface its original error
    // instead of reaching the staged-twin fallback below.
    const stagedFallback = await resolveBareStagedUploadHandle({
      sandbox: params.sandbox,
      filePath,
      inboundFallbackDir: params.inboundFallbackDir,
      enforceWorkspaceBoundary,
    });
    if (stagedFallback) {
      return stagedFallback;
    }
  }
  try {
    const resolved = resolveDirect();
    await enforceWorkspaceBoundary(resolved);
    return {
      resolved: resolved.hostPath ?? resolved.containerPath,
      ...(rewrittenFrom ? { rewrittenFrom } : {}),
    };
  } catch (err) {
    const fallbackDir = params.inboundFallbackDir?.trim();
    if (!fallbackDir) {
      throw err;
    }
    // Substitute the staged basename twin only when the direct target is
    // absent. A present-but-unreadable direct target (or a failed direct
    // stat) keeps its original error instead of being silently replaced.
    let directStat: Awaited<ReturnType<SandboxFsBridge["stat"]>>;
    try {
      directStat = await params.sandbox.bridge.stat({
        filePath,
        cwd: params.sandbox.root,
      });
    } catch {
      throw err;
    }
    if (directStat) {
      throw err;
    }
    const fallbackPath = path.join(fallbackDir, path.basename(filePath));
    try {
      const stat = await params.sandbox.bridge.stat({
        filePath: fallbackPath,
        cwd: params.sandbox.root,
      });
      if (!stat || stat.type !== "file") {
        throw err;
      }
    } catch {
      throw err;
    }
    const resolvedFallback = params.sandbox.bridge.resolvePath({
      filePath: fallbackPath,
      cwd: params.sandbox.root,
    });
    await enforceWorkspaceBoundary(resolvedFallback);
    return {
      resolved: resolvedFallback.hostPath ?? resolvedFallback.containerPath,
      rewrittenFrom: filePath,
    };
  }
}
