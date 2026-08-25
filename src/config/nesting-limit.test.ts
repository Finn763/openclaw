// Covers the bounded JSON nesting contract for config and config-adjacent inputs.
import { describe, expect, it } from "vitest";
import { parseConfigJson5 } from "./io.read-helpers.js";
import {
  assertBoundedJsonNesting,
  assertBoundedRawJsonNesting,
  ConfigNestingDepthError,
  formatConfigNestingDepthMessage,
  MAX_CONFIG_JSON_NESTING_DEPTH,
  measureJsonNestingDepth,
  measureRawJsonNestingDepth,
} from "./nesting-limit.js";

function buildDeepArray(depth: number): unknown {
  let value: unknown = 0;
  for (let i = 0; i < depth; i += 1) {
    value = [value];
  }
  return value;
}

describe("measureRawJsonNestingDepth", () => {
  it("measures bracket nesting and ignores brackets inside strings", () => {
    expect(measureRawJsonNestingDepth('{"a": "["}')).toBe(1);
    expect(measureRawJsonNestingDepth('{"a": "[{["}')).toBe(1);
    expect(measureRawJsonNestingDepth('{"a": "x]"}')).toBe(1);
    expect(measureRawJsonNestingDepth("[1, [2, [3]]]")).toBe(3);
    expect(measureRawJsonNestingDepth('{"a": {"b": [1, {"c": "]"}]}}')).toBe(4);
    expect(measureRawJsonNestingDepth('"plain string [ ]"')).toBe(0);
    expect(measureRawJsonNestingDepth("'single quoted [ ]'")).toBe(0);
    expect(measureRawJsonNestingDepth(String.raw`{"escaped": "a\"b["}`)).toBe(1);
  });

  it("measures pathological 100k-deep input without recursing", () => {
    expect(measureRawJsonNestingDepth("[".repeat(100_000) + "]".repeat(100_000))).toBe(100_000);
  });
});

describe("measureJsonNestingDepth", () => {
  it("measures parsed structures iteratively", () => {
    expect(measureJsonNestingDepth([[[0]]])).toBe(4);
    expect(measureJsonNestingDepth({ a: { b: [1, { c: 2 }] } })).toBe(5);
    expect(measureJsonNestingDepth("leaf")).toBe(1);
  });

  it("measures pathological 100k-deep parsed values without recursing", () => {
    expect(measureJsonNestingDepth(buildDeepArray(100_000))).toBe(100_001);
  });
});

describe("nesting depth assertions", () => {
  it("accepts raw and parsed values at the supported maximum", () => {
    expect(() =>
      assertBoundedJsonNesting(buildDeepArray(MAX_CONFIG_JSON_NESTING_DEPTH - 1), "Test JSON"),
    ).not.toThrow();
    expect(() =>
      assertBoundedRawJsonNesting(
        "[".repeat(MAX_CONFIG_JSON_NESTING_DEPTH) + "]".repeat(MAX_CONFIG_JSON_NESTING_DEPTH),
        "Test JSON",
      ),
    ).not.toThrow();
  });

  it("rejects parsed values past the supported maximum with a wrapped error", () => {
    expect(() =>
      assertBoundedJsonNesting(buildDeepArray(MAX_CONFIG_JSON_NESTING_DEPTH + 1), "Test JSON"),
    ).toThrowError(ConfigNestingDepthError);
    expect(() =>
      assertBoundedJsonNesting(buildDeepArray(MAX_CONFIG_JSON_NESTING_DEPTH + 1), "Test JSON"),
    ).toThrow(/maximum supported nesting depth/);
  });

  it("rejects deep raw text before any parser runs", () => {
    const raw = "[".repeat(100_000) + "]".repeat(100_000);
    expect(() => assertBoundedRawJsonNesting(raw, "Test JSON")).toThrowError(
      ConfigNestingDepthError,
    );
    expect(() => assertBoundedRawJsonNesting(raw, "Test JSON")).toThrowError(
      formatConfigNestingDepthMessage("Test JSON", 100_000),
    );
  });
});

describe("parseConfigJson5", () => {
  it("rejects deeply-nested config text as a clean parse failure", () => {
    const deepRaw = "[".repeat(100_000) + "]".repeat(100_000);
    const result = parseConfigJson5(deepRaw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("nesting depth");
      expect(result.error).toContain(String(MAX_CONFIG_JSON_NESTING_DEPTH));
    }
  });

  it("accepts ordinary config text unchanged", () => {
    expect(parseConfigJson5(`{"gateway": {"mode": "local"}}`)).toEqual({
      ok: true,
      parsed: { gateway: { mode: "local" } },
    });
  });
});
