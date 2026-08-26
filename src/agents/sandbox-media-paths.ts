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
 * A staged-name candidate from the inbound directory listing must stay a
 * single segment: multi-segment or parent-traversal names from a bridge are
 * dropped before any path is built or statted.
 */
function isSafeStagedListingName(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

/**
 * Staged-name candidates for a bare upload handle, derived from the producer
 * contract: the names staging actually wrote into the inbound dir, observed
 * through a directory listing. There is no fixed extension list to keep in
 * sync — any extension and any casing the staging owner preserved is covered.
 *
 * Matching is case-insensitive on the full name (`.JPG`/`.jpg` equivalent, and
 * differently-cased stems included). For an extension-bearing handle only the
 * same name modulo case matches; for an extensionless handle any entry with a
 * `<handle>.<ext>` shape matches. The verbatim handle name is always probed
 * first by the caller and is excluded here. Candidates are ordered
 * deterministically: exact-case stem twins first, then case-insensitive twins,
 * each sorted by lowercased name.
 */
function stagedUploadHandleCandidateNames(params: {
  handle: string;
  stagedEntries: readonly string[];
}): string[] {
  const handle = params.handle;
  const handleLower = handle.toLowerCase();
  const handleHasExtension = path.posix.extname(handle) !== "";
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const entry of params.stagedEntries) {
    if (seen.has(entry) || !isSafeStagedListingName(entry)) {
      continue;
    }
    seen.add(entry);
    const entryLower = entry.toLowerCase();
    if (entryLower === handleLower) {
      if (entry !== handle) {
        matches.push(entry);
      }
      continue;
    }
    if (!handleHasExtension && entryLower.startsWith(`${handleLower}.`)) {
      matches.push(entry);
    }
  }
  return matches.toSorted((a, b) => {
    const aExactStem = a.startsWith(`${handle}.`);
    const bExactStem = b.startsWith(`${handle}.`);
    if (aExactStem !== bExactStem) {
      return aExactStem ? -1 : 1;
    }
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });
}

/**
 * Producer contract for staged upload handles: upload staging writes inbound
 * assets as `file_<id>`-style basenames (e.g. `file_upload-1.png`,
 * `file_1095---<uuid>.ogg`) and agents reference those bare names when they do
 * not carry the full staged path. Plain workspace names are not handles.
 */
const UPLOAD_HANDLE_PREFIX_PATTERN = /^file_/iu;

/**
 * Finds a verified staged inbound twin for a bare handle under the sandbox
 * inbound dir. The verbatim staged name is probed first, then the inbound
 * directory is listed and entry names matching the handle (case-insensitive,
 * any preserved extension) are probed in deterministic order. Each candidate
 * must stat as a regular file. Returns the resolved staged path, or null when
 * no candidate matches. Bridges without a directory-listing capability keep
 * verbatim-only resolution.
 */
async function findVerifiedStagedInboundFile(params: {
  sandbox: SandboxedBridgeMediaPathConfig;
  fallbackDir: string;
  handleName: string;
}): Promise<SandboxResolvedPath | null> {
  // Staged-inbound substitution is reserved for producer-defined upload
  // handles. Some callers derive the name from arbitrary references (e.g. the
  // basename of a host-absolute path whose direct stat failed), so enforce the
  // full candidacy shape plus the producer's `file_<id>` marker here; plain
  // names like `report` keep their ordinary missing-file semantics.
  if (
    !isBareUploadHandleCandidate(params.handleName) ||
    !UPLOAD_HANDLE_PREFIX_PATTERN.test(params.handleName)
  ) {
    return null;
  }
  const fallbackDirNormalized = params.fallbackDir.replace(/\\/g, "/");
  const bridge = params.sandbox.bridge;
  const resolveVerifiedStagedFile = async (
    stagedName: string,
  ): Promise<SandboxResolvedPath | null> => {
    const stagedPath = path.posix.join(fallbackDirNormalized, stagedName);
    const stagedStat = await bridge
      .stat({ filePath: stagedPath, cwd: params.sandbox.root })
      .catch(() => null);
    if (!stagedStat || stagedStat.type !== "file") {
      return null;
    }
    return bridge.resolvePath({
      filePath: stagedPath,
      cwd: params.sandbox.root,
    });
  };
  // The verbatim staged name is always tried first.
  const verbatim = await resolveVerifiedStagedFile(params.handleName);
  if (verbatim) {
    return verbatim;
  }
  // Staged extensions come from the producer contract: the names staging
  // actually wrote into the inbound dir. Matching is case-insensitive and
  // covers any preserved extension, so no fixed extension list exists to fall
  // out of sync with the staging owner.
  if (typeof bridge.readdir !== "function") {
    return null;
  }
  const stagedEntries = await bridge
    .readdir({ filePath: fallbackDirNormalized, cwd: params.sandbox.root })
    .catch(() => null);
  if (!stagedEntries || stagedEntries.length === 0) {
    return null;
  }
  for (const stagedName of stagedUploadHandleCandidateNames({
    handle: params.handleName,
    stagedEntries,
  })) {
    const resolved = await resolveVerifiedStagedFile(stagedName);
    if (resolved) {
      return resolved;
    }
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
 * including its extension and casing, so a bare handle may land as
 * `file_<id>.<ext>` (e.g. a JPG upload staged as `file_<id>.JPG`); resolution
 * therefore matches the verbatim staged name first and then resolves staged
 * twins from the inbound directory listing, case-insensitively and for any
 * preserved extension. Resolution stays bounded: only single-segment,
 * scheme-less relative references qualify, the staged asset must be a regular
 * file under the sandbox inbound dir, and the resulting path still passes the
 * workspace boundary guard.
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
    // is absent. The verbatim staged name is tried first, then staged twins
    // from the inbound directory listing (case-insensitive, any preserved
    // extension — e.g. a JPG upload staged as `handle.JPG`). A present but
    // uninspectable direct target keeps its original error instead of being
    // silently replaced; when the direct stat itself fails (e.g. a
    // host-absolute media path outside the sandbox) the staged twin is still
    // tried, and the original error is preserved when no twin exists.
    let directStat: Awaited<ReturnType<SandboxFsBridge["stat"]>> | null = null;
    try {
      directStat = await params.sandbox.bridge.stat({
        filePath,
        cwd: params.sandbox.root,
      });
    } catch {
      // Treat an uninspectable direct target as absent for fallback purposes.
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
