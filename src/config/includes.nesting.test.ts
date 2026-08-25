// Covers the bounded structural walk in config include resolution.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigIncludes, type IncludeResolver } from "./includes.js";

const ROOT_DIR = path.parse(process.cwd()).root;
const DEFAULT_BASE_PATH = path.join(ROOT_DIR, "config", "openclaw.json");

function createMockResolver(files: Record<string, unknown> = {}): IncludeResolver {
  return {
    readFile: (filePath: string) => {
      if (filePath in files) {
        return JSON.stringify(files[filePath]);
      }
      throw new Error(`ENOENT: no such file: ${filePath}`);
    },
    parseJson: JSON.parse,
  };
}

function resolve(obj: unknown, files: Record<string, unknown> = {}, basePath = DEFAULT_BASE_PATH) {
  return resolveConfigIncludes(obj, basePath, createMockResolver(files));
}

function buildDeepValue(depth: number): unknown {
  let value: unknown = 0;
  for (let i = 0; i < depth; i += 1) {
    value = [value];
  }
  return value;
}

describe("include resolution nesting depth guard", () => {
  it("rejects deeply-nested config structures instead of recursing without bound", () => {
    const deep = buildDeepValue(600);
    let thrown: unknown;
    try {
      resolve(deep);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("ConfigNestingDepthError");
    expect((thrown as Error).message).toContain("nesting depth");
  });

  it("resolves includes through structures within the supported depth", () => {
    const supported = buildDeepValue(100);
    expect(resolve(supported)).toEqual(supported);
  });

  it("rejects a deeply-nested include file before parsing instead of overflowing", () => {
    const deepRaw = "[".repeat(600) + "]".repeat(600);
    let thrown: unknown;
    try {
      resolveConfigIncludes({ $include: "./deep.json" }, DEFAULT_BASE_PATH, {
        readFile: () => deepRaw,
        parseJson: JSON.parse,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/Failed to parse include file/);
  });
});
