// Verifies sandbox media paths resolve through bridge and workspace-only guards.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOutboundMediaFile } from "../media/bounded-read-file.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
} from "./sandbox-media-paths.js";
import { createSandboxFsBridge, type SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";

describe("createSandboxBridgeReadFile", () => {
  it("delegates reads through the sandbox bridge with sandbox root cwd", async () => {
    const readFile = vi.fn(async () => Buffer.from("ok"));
    const scopedRead = createSandboxBridgeReadFile({
      sandbox: {
        root: "/tmp/sandbox-root",
        bridge: {
          readFile,
        } as unknown as SandboxFsBridge,
      },
    });
    await expect(
      readOutboundMediaFile(scopedRead, "media/inbound/example.png", { maxBytes: 1024 }),
    ).resolves.toEqual(Buffer.from("ok"));
    expect(readFile).toHaveBeenCalledWith({
      filePath: "media/inbound/example.png",
      cwd: "/tmp/sandbox-root",
      maxBytes: 1024,
    });
  });

  it("falls back to container paths when the bridge has no host path", async () => {
    const stat = vi.fn(async () => ({ type: "file", size: 1, mtimeMs: 1 }));
    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: {
        root: "/tmp/sandbox-root",
        bridge: {
          resolvePath: ({ filePath }: { filePath: string }) => ({
            relativePath: filePath,
            containerPath: `/sandbox/${filePath}`,
          }),
          stat,
        } as unknown as SandboxFsBridge,
      },
      mediaPath: "image.png",
    });

    expect(resolved).toEqual({ resolved: "/sandbox/image.png" });
    expect(stat).not.toHaveBeenCalled();
  });

  it("keeps workspace-only container paths under the sandbox workspace mount", async () => {
    // Container paths must stay inside the remote workspace mount when workspaceOnly is set.
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) => {
      if (filePath === "/tmp/sandbox-root") {
        return {
          relativePath: "",
          containerPath: "/remote/workspace",
        };
      }
      return {
        relativePath: filePath,
        containerPath: `/remote/workspace/${filePath}`,
      };
    });

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: {
        root: "/tmp/sandbox-root",
        workspaceOnly: true,
        bridge: {
          resolvePath,
        } as unknown as SandboxFsBridge,
      },
      mediaPath: "image.png",
    });

    expect(resolved).toEqual({ resolved: "/remote/workspace/image.png" });
    expect(resolvePath).toHaveBeenCalledWith({
      filePath: "/tmp/sandbox-root",
      cwd: "/tmp/sandbox-root",
    });
  });

  it("rejects workspace-only container paths outside the sandbox workspace mount", async () => {
    await expect(
      resolveSandboxedBridgeMediaPath({
        sandbox: {
          root: "/tmp/sandbox-root",
          workspaceOnly: true,
          bridge: {
            resolvePath: vi.fn(({ filePath }: { filePath: string }) =>
              filePath === "/tmp/sandbox-root"
                ? {
                    relativePath: "",
                    containerPath: "/remote/workspace",
                  }
                : {
                    relativePath: filePath,
                    containerPath: "/remote/agent/secret.png",
                  },
            ),
          } as unknown as SandboxFsBridge,
        },
        mediaPath: "/remote/agent/secret.png",
      }),
    ).rejects.toThrow("Sandbox path escapes workspace root: /remote/agent/secret.png");
  });

  it("rewrites inbound media URIs before direct sandbox resolution", async () => {
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) => ({
      hostPath: `/tmp/sandbox-root/${filePath}`,
      relativePath: filePath,
      containerPath: `/sandbox/${filePath}`,
    }));
    const stat = vi.fn(async () => ({ type: "file", size: 1, mtimeMs: 1 }));

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: {
        root: "/tmp/sandbox-root",
        bridge: {
          resolvePath,
          stat,
        } as unknown as SandboxFsBridge,
      },
      mediaPath: "media://inbound/photo.png",
      inboundFallbackDir: "media/inbound",
    });

    expect(stat).toHaveBeenCalledWith({
      filePath: "media/inbound/photo.png",
      cwd: "/tmp/sandbox-root",
    });
    expect(resolvePath).toHaveBeenCalledWith({
      filePath: "media/inbound/photo.png",
      cwd: "/tmp/sandbox-root",
    });
    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/photo.png",
      rewrittenFrom: "media://inbound/photo.png",
    });
  });

  it("rejects missing staged inbound media URIs before direct sandbox resolution", async () => {
    const resolvePath = vi.fn();
    await expect(
      resolveSandboxedBridgeMediaPath({
        sandbox: {
          root: "/tmp/sandbox-root",
          bridge: {
            resolvePath,
            stat: vi.fn(async () => null),
          } as unknown as SandboxFsBridge,
        },
        mediaPath: "media://inbound/missing.png",
        inboundFallbackDir: "media/inbound",
      }),
    ).rejects.toThrow("Sandbox media reference is not staged: media://inbound/missing.png");
    expect(resolvePath).not.toHaveBeenCalled();
  });
});

describe("bare staged upload handle fallback", () => {
  const hostBridge = (
    stat: (params: {
      filePath: string;
    }) => Promise<{ type: string; size: number; mtimeMs: number } | null>,
    listedEntries: readonly string[] = [],
  ) => {
    const readdir = vi.fn(async () => [...listedEntries]);
    return {
      stat,
      readdir,
      resolvePath: vi.fn(({ filePath }: { filePath: string }) => ({
        hostPath: `/tmp/sandbox-root/${filePath}`,
        relativePath: filePath,
        containerPath: `/sandbox/${filePath}`,
      })),
    };
  };

  it("resolves a bare upload handle to its verified staged inbound asset", async () => {
    const stat = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === "media/inbound/file_upload-1.png" ? { type: "file", size: 1, mtimeMs: 1 } : null,
    );
    const bridge = hostBridge(stat);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_upload-1.png",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/file_upload-1.png",
      rewrittenFrom: "file_upload-1.png",
    });
    expect(stat).toHaveBeenNthCalledWith(1, {
      filePath: "file_upload-1.png",
      cwd: "/tmp/sandbox-root",
    });
    expect(stat).toHaveBeenNthCalledWith(2, {
      filePath: "media/inbound/file_upload-1.png",
      cwd: "/tmp/sandbox-root",
    });
    expect(bridge.resolvePath).toHaveBeenLastCalledWith({
      filePath: "media/inbound/file_upload-1.png",
      cwd: "/tmp/sandbox-root",
    });
  });

  it("resolves an extensionless bare handle to its staged twin with a preserved upload extension", async () => {
    // A JPG upload stages as media/inbound/file_upload-1.jpg while the agent
    // references the bare handle file_upload-1 (issue #129084): the verbatim
    // probe misses and the inbound directory listing supplies the staged twin.
    const stat = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === "media/inbound/file_upload-1.jpg" ? { type: "file", size: 1, mtimeMs: 1 } : null,
    );
    const bridge = hostBridge(stat, ["file_upload-1.jpg"]);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_upload-1",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/file_upload-1.jpg",
      rewrittenFrom: "file_upload-1",
    });
    expect(stat).toHaveBeenNthCalledWith(1, {
      filePath: "file_upload-1",
      cwd: "/tmp/sandbox-root",
    });
    expect(stat).toHaveBeenNthCalledWith(2, {
      filePath: "media/inbound/file_upload-1",
      cwd: "/tmp/sandbox-root",
    });
    expect(bridge.readdir).toHaveBeenCalledWith({
      filePath: "media/inbound",
      cwd: "/tmp/sandbox-root",
    });
    expect(stat).toHaveBeenNthCalledWith(3, {
      filePath: "media/inbound/file_upload-1.jpg",
      cwd: "/tmp/sandbox-root",
    });
    expect(bridge.resolvePath).toHaveBeenLastCalledWith({
      filePath: "media/inbound/file_upload-1.jpg",
      cwd: "/tmp/sandbox-root",
    });
  });

  it("prefers the verbatim staged name over directory-listing twins", async () => {
    const stat = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === "media/inbound/file_upload-2" || filePath === "media/inbound/file_upload-2.jpg"
        ? { type: "file", size: 1, mtimeMs: 1 }
        : null,
    );
    const bridge = hostBridge(stat, ["file_upload-2.jpg"]);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_upload-2",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/file_upload-2",
      rewrittenFrom: "file_upload-2",
    });
    // A verbatim hit means the inbound directory is never listed.
    expect(stat).toHaveBeenCalledTimes(2);
    expect(bridge.readdir).not.toHaveBeenCalled();
    expect(bridge.resolvePath).toHaveBeenLastCalledWith({
      filePath: "media/inbound/file_upload-2",
      cwd: "/tmp/sandbox-root",
    });
  });

  it("leaves an extensionless bare handle workspace-relative when no staged variant matches", async () => {
    const stat = vi.fn(async () => null);
    const bridge = hostBridge(stat, ["unrelated.png", "other.bin"]);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_ghost",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({ resolved: "/tmp/sandbox-root/file_ghost" });
    expect(stat).toHaveBeenNthCalledWith(1, {
      filePath: "file_ghost",
      cwd: "/tmp/sandbox-root",
    });
    expect(stat).toHaveBeenNthCalledWith(2, {
      filePath: "media/inbound/file_ghost",
      cwd: "/tmp/sandbox-root",
    });
    // The inbound dir is listed once; no listing entry matches the handle, so
    // no further stats are issued.
    expect(bridge.readdir).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(2);
    expect(bridge.resolvePath).toHaveBeenCalledTimes(1);
  });

  it("skips listing twins that are not regular files", async () => {
    const stat = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === "media/inbound/file_dir.jpg" ? { type: "directory", size: 0, mtimeMs: 1 } : null,
    );
    const bridge = hostBridge(stat, ["file_dir.jpg"]);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_dir",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({ resolved: "/tmp/sandbox-root/file_dir" });
    const probed = stat.mock.calls.map((call) => (call[0] as { filePath: string }).filePath);
    expect(probed[0]).toBe("file_dir");
    expect(probed[1]).toBe("media/inbound/file_dir");
    expect(probed[2]).toBe("media/inbound/file_dir.jpg");
    expect(probed.length).toBe(3);
    expect(bridge.resolvePath).toHaveBeenCalledTimes(1);
  });

  it("resolves an extensionless bare handle to a staged twin with an uppercase preserved extension", async () => {
    // Staging preserves the uploaded basename verbatim, including extension
    // casing: a JPG upload can land as file_upload-1.JPG. The producer-side
    // directory listing must resolve it with no fixed extension list.
    const stat = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === "media/inbound/file_upload-1.JPG" ? { type: "file", size: 1, mtimeMs: 1 } : null,
    );
    const bridge = hostBridge(stat, ["file_upload-1.JPG"]);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_upload-1",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/file_upload-1.JPG",
      rewrittenFrom: "file_upload-1",
    });
    expect(stat).toHaveBeenLastCalledWith({
      filePath: "media/inbound/file_upload-1.JPG",
      cwd: "/tmp/sandbox-root",
    });
  });

  it("resolves an extensionless bare handle to a staged twin with an unlisted preserved extension", async () => {
    // An extension absent from any enumeration (e.g. .opus) must still resolve:
    // extensions come from the producer's actual staged names, not a list.
    const stat = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === "media/inbound/file_upload-1.opus"
        ? { type: "file", size: 1, mtimeMs: 1 }
        : null,
    );
    const bridge = hostBridge(stat, ["file_upload-1.opus"]);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_upload-1",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/file_upload-1.opus",
      rewrittenFrom: "file_upload-1",
    });
  });

  it("resolves an extension-bearing bare handle to its differently-cased staged twin", async () => {
    // Case-insensitive matching applies to the full staged name: a handle
    // file_upload-1.png matches a staged file_upload-1.PNG (.JPG/.jpg equivalent).
    const stat = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === "media/inbound/file_upload-1.PNG" ? { type: "file", size: 1, mtimeMs: 1 } : null,
    );
    const bridge = hostBridge(stat, ["file_upload-1.PNG"]);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_upload-1.png",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/file_upload-1.PNG",
      rewrittenFrom: "file_upload-1.png",
    });
  });

  it("matches staged stems case-insensitively", async () => {
    // Staging preserves arbitrary basename casing, so the listing twin's stem
    // may differ in case from the bare handle.
    const stat = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === "media/inbound/FILE_Upload-1.jpg" ? { type: "file", size: 1, mtimeMs: 1 } : null,
    );
    const bridge = hostBridge(stat, ["FILE_Upload-1.jpg"]);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_upload-1",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/FILE_Upload-1.jpg",
      rewrittenFrom: "file_upload-1",
    });
  });

  it("prefers an exact-case stem twin over a differently-cased stem twin", async () => {
    // The exact-case stem twin is probed first; when it is not a regular file,
    // probing continues to the case-insensitive twin in listing order.
    const stat = vi.fn(async ({ filePath }: { filePath: string }) => {
      if (filePath === "media/inbound/file_upload-3.jpg") {
        return { type: "directory", size: 0, mtimeMs: 1 };
      }
      if (filePath === "media/inbound/FILE_UPLOAD-3.png") {
        return { type: "file", size: 1, mtimeMs: 1 };
      }
      return null;
    });
    const bridge = hostBridge(stat, ["FILE_UPLOAD-3.png", "file_upload-3.jpg"]);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_upload-3",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/FILE_UPLOAD-3.png",
      rewrittenFrom: "file_upload-3",
    });
    const probed = stat.mock.calls.map((call) => (call[0] as { filePath: string }).filePath);
    expect(probed.indexOf("media/inbound/file_upload-3.jpg")).toBeGreaterThan(-1);
    expect(probed.indexOf("media/inbound/file_upload-3.jpg")).toBeLessThan(
      probed.indexOf("media/inbound/FILE_UPLOAD-3.png"),
    );
  });

  it("ignores non-single-segment entries returned by the bridge listing", async () => {
    // A bridge listing must only supply single-segment names; anything else is
    // dropped before any stat, so hostile entries can never redirect probing.
    const stat = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === "media/inbound/file_evil.jpg" ? { type: "file", size: 1, mtimeMs: 1 } : null,
    );
    const bridge = hostBridge(stat, ["../evil.jpg", "sub/evil.jpg", "file_evil.jpg"]);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_evil",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/file_evil.jpg",
      rewrittenFrom: "file_evil",
    });
    const probed = stat.mock.calls.map((call) => (call[0] as { filePath: string }).filePath);
    expect(probed.some((p) => p.includes(".."))).toBe(false);
    expect(probed.some((p) => p.includes("sub/"))).toBe(false);
  });

  it("treats a failed directory listing as no staged variants", async () => {
    const stat = vi.fn(async () => null);
    const readdir = vi.fn(async () => {
      throw new Error("list failed");
    });
    const bridge = { ...hostBridge(stat), readdir };

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_listerr",
      inboundFallbackDir: "media/inbound",
    });

    // Listing failure degrades to verbatim-only probing; resolution falls
    // through to the (missing) workspace-relative path without throwing.
    expect(resolved).toEqual({ resolved: "/tmp/sandbox-root/file_listerr" });
    expect(readdir).toHaveBeenCalledTimes(1);
  });

  it("keeps verbatim-only probing when the bridge lacks directory listing", async () => {
    // Bridges without the optional readdir capability resolve staged twins by
    // exact name only; extension resolution requires the listing capability.
    const stat = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === "media/inbound/file_nolist" ? { type: "file", size: 1, mtimeMs: 1 } : null,
    );
    const bridge = {
      stat,
      resolvePath: vi.fn(({ filePath }: { filePath: string }) => ({
        hostPath: `/tmp/sandbox-root/${filePath}`,
        relativePath: filePath,
        containerPath: `/sandbox/${filePath}`,
      })),
    };

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_nolist",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/file_nolist",
      rewrittenFrom: "file_nolist",
    });
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it("dedupes repeated listing entries", async () => {
    const stat = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === "media/inbound/file_dup.jpg" ? { type: "file", size: 1, mtimeMs: 1 } : null,
    );
    const bridge = hostBridge(stat, ["file_dup.jpg", "file_dup.jpg"]);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_dup",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/file_dup.jpg",
      rewrittenFrom: "file_dup",
    });
    expect(
      stat.mock.calls.filter(
        (call) => (call[0] as { filePath: string }).filePath === "media/inbound/file_dup.jpg",
      ),
    ).toHaveLength(1);
  });

  it("keeps an existing workspace file authoritative over a staged inbound twin", async () => {
    const stat = vi.fn(async () => ({ type: "file", size: 1, mtimeMs: 1 }));
    const bridge = hostBridge(stat);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "img.png",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({ resolved: "/tmp/sandbox-root/img.png" });
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith({ filePath: "img.png", cwd: "/tmp/sandbox-root" });
    expect(bridge.resolvePath).toHaveBeenCalledTimes(1);
  });

  it("leaves a bare handle workspace-relative when no staged asset exists", async () => {
    const stat = vi.fn(async () => null);
    const bridge = hostBridge(stat);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_ghost.png",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({ resolved: "/tmp/sandbox-root/file_ghost.png" });
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it("never rewrites multi-segment relative paths through the staged fallback", async () => {
    const stat = vi.fn(async () => null);
    const bridge = hostBridge(stat);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "sub/img.png",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({ resolved: "/tmp/sandbox-root/sub/img.png" });
    expect(stat).not.toHaveBeenCalled();
  });

  it("keeps the original stat error when the direct workspace file is unreadable", async () => {
    // Exists-but-unreadable direct files must never be silently replaced by
    // the staged inbound twin: the original stat error surfaces instead.
    const stat = vi.fn(async ({ filePath }: { filePath: string }) => {
      if (filePath === "file_blocked.png") {
        throw new Error("stat failed for /workspace/file_blocked.png: Permission denied");
      }
      return { type: "file", size: 1, mtimeMs: 1 };
    });
    const bridge = hostBridge(stat);

    await expect(
      resolveSandboxedBridgeMediaPath({
        sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
        mediaPath: "file_blocked.png",
        inboundFallbackDir: "media/inbound",
      }),
    ).rejects.toThrow("Permission denied");
    // The staged twin must never be probed after the direct stat fails.
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith({ filePath: "file_blocked.png", cwd: "/tmp/sandbox-root" });
    expect(bridge.resolvePath).not.toHaveBeenCalled();
  });

  it("does not rewrite a bare handle when the staged twin is not a regular file", async () => {
    const stat = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === "media/inbound/file_dir.png" ? { type: "directory", size: 0, mtimeMs: 1 } : null,
    );
    const bridge = hostBridge(stat);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "file_dir.png",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({ resolved: "/tmp/sandbox-root/file_dir.png" });
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it("preserves the original direct-resolution error when the direct target is present", async () => {
    // When direct resolution fails for a present (non-absent) target, the
    // inbound basename twin must not be substituted: keep the original error.
    const resolveError = new Error("bridge resolve failed");
    const stat = vi.fn(async () => ({ type: "file", size: 1, mtimeMs: 1 }));
    const bridge = {
      stat,
      resolvePath: vi.fn(({ filePath }: { filePath: string }) => {
        if (filePath === "sub/file_link.png") {
          throw resolveError;
        }
        return {
          hostPath: `/tmp/sandbox-root/${filePath}`,
          relativePath: filePath,
          containerPath: `/sandbox/${filePath}`,
        };
      }),
    };

    await expect(
      resolveSandboxedBridgeMediaPath({
        sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
        mediaPath: "sub/file_link.png",
        inboundFallbackDir: "media/inbound",
      }),
    ).rejects.toBe(resolveError);
    // Only the direct-absence probe ran; the staged twin was never resolved.
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith({ filePath: "sub/file_link.png", cwd: "/tmp/sandbox-root" });
  });

  it("never rewrites scheme references through the staged fallback", async () => {
    const stat = vi.fn(async () => null);
    const bridge = hostBridge(stat);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: "/tmp/sandbox-root", bridge: bridge as unknown as SandboxFsBridge },
      mediaPath: "http://example.test/a.png",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({ resolved: "/tmp/sandbox-root/http://example.test/a.png" });
    expect(stat).not.toHaveBeenCalled();
  });
});

describe("sandbox media container file URLs", () => {
  let tempRoot = "";
  let workspace = "";
  let imagePath = "";
  let bridge: SandboxFsBridge;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-media-container-url-"));
    workspace = path.join(tempRoot, "workspace");
    imagePath = path.join(workspace, "image.png");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(imagePath, "image", "utf8");
    bridge = createSandboxFsBridge({
      sandbox: createSandboxTestContext({
        overrides: {
          workspaceDir: workspace,
          agentWorkspaceDir: workspace,
        },
      }),
    });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it.each([
    "file:///workspace/image.png",
    "FILE:///workspace/image.png",
    "file:/workspace/image.png",
    "FILE:/workspace/image.png",
  ])("reads a mounted file from %s", async (mediaPath) => {
    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: workspace, bridge, workspaceOnly: true },
      mediaPath,
    });

    expect(resolved).toEqual({ resolved: imagePath });
    await expect(fs.readFile(resolved.resolved, "utf8")).resolves.toBe("image");
  });

  it.each([
    "file:///outside/image.png",
    "FILE:///outside/image.png",
    "file:/outside/image.png",
    "FILE:/outside/image.png",
  ])("rejects an outside mounted file from %s", async (mediaPath) => {
    await expect(
      resolveSandboxedBridgeMediaPath({
        sandbox: { root: workspace, bridge, workspaceOnly: true },
        mediaPath,
      }),
    ).rejects.toThrow(/escapes sandbox root/i);
  });

  it.each([
    {
      mediaPath: "file://remote.example/workspace/image.png",
      error: "remote hosts are not allowed",
    },
    { mediaPath: "file:///workspace/image%2f.png", error: "cannot encode path separators" },
    { mediaPath: "FILE:/workspace/image%5C.png", error: "cannot encode path separators" },
  ])("rejects an unsafe file URL from $mediaPath", async ({ mediaPath, error }) => {
    await expect(
      resolveSandboxedBridgeMediaPath({
        sandbox: { root: workspace, bridge, workspaceOnly: true },
        mediaPath,
      }),
    ).rejects.toThrow(error);
  });
});
