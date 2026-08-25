import { createHash } from "node:crypto";

/**
 * Numeric bundle-format version, negotiated between Gateway and node hosts.
 *
 * Node hosts declare the format they understand in their runner inventory
 * (workerHost.bundleFormat). A Gateway that built a v2-format bundle refuses
 * to dispatch the install to a node that only speaks v1 — the node would
 * otherwise fail bootstrap with a silent "does not match its expected hash".
 */
export const WORKER_BUNDLE_FORMAT_VERSION = 2;
export const WORKER_BUNDLE_MANIFEST_VERSION = `openclaw-worker-bundle-v${WORKER_BUNDLE_FORMAT_VERSION}`;
export const WORKER_BUNDLE_ENTRY_PATH = "worker.mjs";
export const WORKER_BUNDLE_RSYNC_RECEIVER_PATH = "workspace-rsync-receiver.mjs";

export function compareWorkerBundlePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type WorkerBundleHashEntry = {
  path: string;
  size: number;
  sha256: string;
};

/**
 * Hashes the canonical worker manifest shared by Gateway bundles and node-local installs.
 *
 * The identity is deliberately platform-neutral: Unix permission bits are excluded because
 * Windows cannot preserve them after extraction (fs.lstat().mode reports 0o666 even after
 * chmod), which previously made a Linux-built bundle hash-mismatch on a Windows node.
 */
export function hashWorkerBundleManifest(entries: readonly WorkerBundleHashEntry[]): string {
  const hash = createHash("sha256");
  hash.update(`${WORKER_BUNDLE_MANIFEST_VERSION}\0`);
  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.size}\0${entry.sha256}\0`);
  }
  return hash.digest("hex");
}
