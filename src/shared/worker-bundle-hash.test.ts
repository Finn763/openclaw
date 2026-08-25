import { describe, expect, it } from "vitest";
import { hashWorkerBundleManifest, type WorkerBundleHashEntry } from "./worker-bundle-hash.js";

describe("worker bundle manifest hash", () => {
  it("does not bind the canonical identity to Unix permission bits", () => {
    // A Linux Gateway archives its staging tree with Unix modes; Windows extraction
    // lstat() reports 0o666 for the same files, so the identity must not depend on
    // the mode bits the tar header carries (issue #128889).
    const executableModes = [
      { path: "worker.mjs", mode: 0o700, size: 20, sha256: "a".repeat(64) },
      { path: "workspace-rsync-receiver.mjs", mode: 0o700, size: 34, sha256: "b".repeat(64) },
    ] as unknown as WorkerBundleHashEntry[];
    const readableModes = [
      { path: "worker.mjs", mode: 0o666, size: 20, sha256: "a".repeat(64) },
      { path: "workspace-rsync-receiver.mjs", mode: 0o666, size: 34, sha256: "b".repeat(64) },
    ] as unknown as WorkerBundleHashEntry[];
    expect(hashWorkerBundleManifest(executableModes)).toBe(hashWorkerBundleManifest(readableModes));
  });

  it("still binds the identity to exact paths, sizes, and content", () => {
    const entries = [
      { path: "worker.mjs", size: 20, sha256: "a".repeat(64) },
      { path: "workspace-rsync-receiver.mjs", size: 34, sha256: "b".repeat(64) },
    ] as unknown as WorkerBundleHashEntry[];
    const reference = hashWorkerBundleManifest(entries);
    expect(
      hashWorkerBundleManifest([
        { path: "worker.mjs", size: 20, sha256: "a".repeat(64) },
        { path: "workspace-rsync-receiver.mjs", size: 34, sha256: "c".repeat(64) },
      ] as unknown as WorkerBundleHashEntry[]),
    ).not.toBe(reference);
    expect(
      hashWorkerBundleManifest([
        { path: "worker.mjs", size: 20, sha256: "a".repeat(64) },
        { path: "workspace-rsync-receiver.mjs", size: 35, sha256: "b".repeat(64) },
      ] as unknown as WorkerBundleHashEntry[]),
    ).not.toBe(reference);
  });
});
