import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  extractWorkerBundleArchive,
  readWorkerBundleArchiveManifest,
  readWorkerBundleDirectoryManifest,
} from "./worker-bundle-archive.js";
import { hashWorkerBundleManifest } from "./worker-bundle-hash.js";

describe("worker bundle archive", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-bundle-archive-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("extracts only a manifest-identical regular-file bundle", async () => {
    const source = path.join(root, "source");
    const archive = path.join(root, "bundle.tgz");
    const destination = path.join(root, "destination");
    await fs.mkdir(path.join(source, "dist"), { recursive: true });
    await fs.writeFile(path.join(source, "openclaw.mjs"), "#!/usr/bin/env node\n");
    await fs.chmod(path.join(source, "openclaw.mjs"), 0o700);
    await fs.writeFile(path.join(source, "dist", "worker.js"), "export const worker = true;\n");
    await fs.chmod(path.join(source, "dist", "worker.js"), 0o600);
    await fs.writeFile(path.join(source, "dist", "Upper.js"), "export const upper = true;\n");
    await fs.chmod(path.join(source, "dist", "Upper.js"), 0o600);
    const sourceManifest = await readWorkerBundleDirectoryManifest({
      root: source,
      limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
    });
    const bundleHash = hashWorkerBundleManifest(sourceManifest);
    await tar.create({ cwd: source, file: archive, gzip: true, noDirRecurse: true }, [
      "openclaw.mjs",
      "dist/worker.js",
      "dist/Upper.js",
    ]);

    await extractWorkerBundleArchive({
      tarballPath: archive,
      destination,
      expectedBundleHash: bundleHash,
      limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
    });

    expect(
      hashWorkerBundleManifest(
        await readWorkerBundleDirectoryManifest({
          root: destination,
          limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
        }),
      ),
    ).toBe(bundleHash);
  });

  it("rejects archive links before extraction", async () => {
    const source = path.join(root, "source");
    const archive = path.join(root, "bundle.tgz");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "target"), "target");
    await fs.symlink("target", path.join(source, "openclaw.mjs"));
    await tar.create({ cwd: source, file: archive, gzip: true, noDirRecurse: true }, [
      "openclaw.mjs",
    ]);

    await expect(
      readWorkerBundleArchiveManifest(archive, DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS),
    ).rejects.toThrow("Invalid worker bundle tar entry");
  });

  it("rejects a valid archive under the wrong logical hash", async () => {
    const source = path.join(root, "source");
    const archive = path.join(root, "bundle.tgz");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "openclaw.mjs"), "worker");
    await tar.create({ cwd: source, file: archive, gzip: true, noDirRecurse: true }, [
      "openclaw.mjs",
    ]);

    await expect(
      extractWorkerBundleArchive({
        tarballPath: archive,
        destination: path.join(root, "destination"),
        expectedBundleHash: "f".repeat(64),
        limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
      }),
    ).rejects.toThrow("archive manifest does not match");
  });

  it("installs a bundle whose tar header modes a platform cannot preserve after extraction", async () => {
    // A Linux Gateway archives its staging tree with Unix permission bits (e.g. 0o700).
    // Windows extraction cannot preserve those bits: lstat reports 0o666 for the same file,
    // so the bundle identity must not include them (issue #128889).
    const archive = path.join(root, "unix-mode-bundle.tgz");
    const destination = path.join(root, "destination");
    await fs.writeFile(
      archive,
      buildTarGzip([
        { path: "worker.mjs", mode: 0o700, contents: "export const worker = true;\n" },
        {
          path: "workspace-rsync-receiver.mjs",
          mode: 0o700,
          contents: "export const receiver = true;\n",
        },
      ]),
    );
    const bundleHash = hashWorkerBundleManifest(
      await readWorkerBundleArchiveManifest(archive, DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS),
    );

    await expect(
      extractWorkerBundleArchive({
        tarballPath: archive,
        destination,
        expectedBundleHash: bundleHash,
        limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
      }),
    ).resolves.toBeUndefined();
    expect(
      hashWorkerBundleManifest(
        await readWorkerBundleDirectoryManifest({
          root: destination,
          limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
        }),
      ),
    ).toBe(bundleHash);
  });
});

/** Builds a gzip'd ustar archive carrying explicit Unix modes (a Linux Gateway-style bundle). */
function buildTarGzip(
  entries: ReadonlyArray<{ path: string; mode: number; contents: string }>,
): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.contents, "utf8");
    const header = Buffer.alloc(512);
    Buffer.from(entry.path, "utf8").copy(header, 0, 0, 100);
    header.write(`${entry.mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write("root\0", 265, 8, "ascii");
    header.write("root\0", 297, 8, "ascii");
    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, content);
    const remainder = content.length % 512;
    if (remainder > 0) {
      blocks.push(Buffer.alloc(512 - remainder));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
