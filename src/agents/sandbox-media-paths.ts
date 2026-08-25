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
 * Candidate extensions probed for extensionless bare upload handles, most
 * common first. Inbound staging preserves the uploaded basename including its
 * extension, so a bare `file_<id>` handle whose staged asset landed as
 * `file_<id>.<ext>` (for example a JPG upload staged as `file_<id>.jpg`) is
 * found through these probes. The verbatim staged name is always tried first;
 * these probes only run when the handle itself carries no extension.
 */
const BARE_HANDLE_EXTENSION_PROBES = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
  "tif",
  "tiff",
  "heic",
  "heif",
  "ico",
  "mp4",
  "mov",
  "webm",
  "mkv",
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "flac",
  "pdf",
  "txt",
  "md",
  "csv",
  "json",
  "zip",
] as const;

/**
 * Ordered staged-name candidates for a bare upload handle: the verbatim name
 * first, then its extension variants. Extension variants only apply when the
 * handle itself has no extension, matching the reported `file_<id>` shape.
 */
function stagedUploadHandleCandidateNames(handle: string): string[] {
  if (path.posix.extname(handle) !== "") {
    return [handle];
  }
  return [handle, ...BARE_HANDLE_EXTENSION_PROBES.map((ext) => `${handle}.${ext}`)];
}

/**
 * Finds a verified staged inbound twin for a bare handle under the sandbox
 * inbound dir. Candidates are tried in order (verbatim first, then extension
 * variants); each must stat as a regular file. Returns the resolved staged
 * path, or null when no candidate matches.
 */
async function findVerifiedStagedInboundFile(params: {
  sandbox: SandboxedBridgeMediaPathConfig;
  fallbackDir: string;
  handleName: string;
}): Promise<SandboxResolvedPath | null> {
  const fallbackDirNormalized = params.fallbackDir.replace(/\\/g, "/");
  for (const stagedName of stagedUploadHandleCandidateNames(params.handleName)) {
    const stagedPath = path.posix.join(fallbackDirNormalized, stagedName);
    const stagedStat = await params.sandbox.bridge
      .stat({ filePath: stagedPath, cwd: params.sandbox.root })
      .catch(() => null);
    if (!stagedStat || stagedStat.type !== "file") {
      continue;
    }
    return params.sandbox.bridge.resolvePath({
      filePath: stagedPath,
      cwd: params.sandbox.root,
    });
  }
  return null;
}

/**
 * Maps a bare upload handle to its verified staged inbound asset when the
 * workspace-relative target is absent.
 *
 * Upload staging copies inbound media into `media/inbound/*` inside the
 * sandbox workspace; canonical `media://inbound/<id>` references are rewritten
 * upstream, but bare handles (e.g. `file_<id>`) previously resolved against
 * the sandbox root and read ENOENT. Staging preserves the uploaded basename
 * including its extension, so a bare handle may land as `file_<id>.<ext>`
 * (e.g. a JPG upload staged as `file_<id>.jpg`); resolution therefore matches
 * the verbatim staged name first and falls back to same-handle extension
 * variants. Resolution stays bounded: only single-segment, scheme-less
 * relative references qualify, the staged asset must be a regular file under
 * the sandbox inbound dir, and the resulting path still passes the workspace
 * boundary guard.
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
  const resolvedFallback = await findVerifiedStagedInboundFile({
    sandbox: params.sandbox,
    fallbackDir,
    handleName: handle,
  });
  if (!resolvedFallback) {
    return null;
  }
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
    // Substitute a verified staged basename twin only when the direct target
    // is absent. The verbatim staged name is tried first, then same-handle
    // extension variants (e.g. a JPG upload staged with its extension). A
    // present-but-unreadable direct target (or a failed direct stat) keeps its
    // original error instead of being silently replaced.
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
    const resolvedFallback = await findVerifiedStagedInboundFile({
      sandbox: params.sandbox,
      fallbackDir,
      handleName: path.basename(filePath),
    });
    if (!resolvedFallback) {
      throw err;
    }
    await enforceWorkspaceBoundary(resolvedFallback);
    return {
      resolved: resolvedFallback.hostPath ?? resolvedFallback.containerPath,
      rewrittenFrom: filePath,
    };
  }
}
