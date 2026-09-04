import { describe, expect, it } from "vitest";
import { testing } from "./agents.js";

const { cleanupIdentityEquals, cleanupPathIdentity } = testing;

// Regression for #137416: NTFS file ids past 2^53 must survive capture
// exactly, and the fence re-reads them exactly (bigint lstat) so deletion can
// proceed instead of throwing "exceeds the safe integer range".
describe("agent delete cleanup identity (137416)", () => {
  it("keeps safe ids as numbers (prior-release journal compatible)", () => {
    expect(cleanupPathIdentity({ dev: 1n, ino: 7n })).toEqual({ dev: 1, ino: 7 });
    expect(cleanupPathIdentity({ dev: 1, ino: 7 })).toEqual({ dev: 1, ino: 7 });
  });

  it("captures unsafe NTFS ids as exact strings", () => {
    expect(cleanupPathIdentity({ dev: 1n, ino: 9007199254740993n })).toEqual({
      dev: 1,
      ino: "9007199254740993",
    });
  });

  it("returns null when identity parts are missing", () => {
    expect(cleanupPathIdentity(undefined)).toBeNull();
    expect(cleanupPathIdentity({ dev: 1n })).toBeNull();
  });

  it("matches an exact re-read of an unsafe NTFS id", () => {
    // The fence re-reads unsafe prepared ids with bigint lstat, so both sides
    // are exact here — never the rounded number-valued fs-safe stat.
    expect(cleanupIdentityEquals("9007199254740993", String(9007199254740993n))).toBe(true);
  });

  it("still rejects a rounded number recheck of an unsafe id (fail closed)", () => {
    // 9007199254740993n rounds to 9007199254740992 as a double; if the exact
    // re-read ever falls back to the fs-safe stat, this must NOT match.
    expect(cleanupIdentityEquals("9007199254740993", 9007199254740992)).toBe(false);
  });

  it("compares safe ids across number/string journal forms", () => {
    expect(cleanupIdentityEquals(7, "7")).toBe(true);
    expect(cleanupIdentityEquals(100, 200)).toBe(false);
  });

  it("rejects a substituted path whose id rounds to the same double", () => {
    // 9007199254740993 and 9007199254740992 are distinct file ids that
    // collapse to one IEEE-754 number; the fence must tell them apart.
    expect(cleanupIdentityEquals("9007199254740993", "9007199254740992")).toBe(false);
  });

  it("round-trips mixed journal identities through JSON", () => {
    const prepared = cleanupPathIdentity({ dev: 1n, ino: 9007199254740993n });
    const journaled = structuredClone(prepared);
    expect(journaled).toEqual(prepared);
    // Safe stays numeric (prior release recovers it); only the unsafe part is
    // a string, which the old release never produced or consumed (it threw).
    expect(typeof journaled?.dev).toBe("number");
    expect(typeof journaled?.ino).toBe("string");
    expect(JSON.stringify(prepared)).toBe('{"dev":1,"ino":"9007199254740993"}');
  });
});
