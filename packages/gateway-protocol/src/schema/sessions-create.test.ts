import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionsCreateResultSchema, validateSessionsCreateParams } from "../index.js";
import { SessionRowSchema } from "./sessions-row.js";

describe("sessions.create schema", () => {
  it.each(["read-only", "guarded", "workspace", "full"])(
    "accepts the closed permission mode %s",
    (permissionMode) => {
      expect(validateSessionsCreateParams({ agentId: "main", permissionMode })).toBe(true);
    },
  );

  it("rejects unknown permission modes", () => {
    expect(validateSessionsCreateParams({ agentId: "main", permissionMode: "unrestricted" })).toBe(
      false,
    );
  });

  it("accepts additive create-time visibility values", () => {
    for (const visibility of ["shared", "read-only", "suggest", "draft"]) {
      expect(validateSessionsCreateParams({ agentId: "main", visibility })).toBe(true);
    }
  });

  it("rejects unknown visibility values", () => {
    expect(validateSessionsCreateParams({ agentId: "main", visibility: "private" })).toBe(false);
  });

  it("accepts the canonical created session projection", () => {
    for (const field of [
      "thinkingLevel",
      "thinkingLevels",
      "thinkingOptions",
      "thinkingDefault",
    ] as const) {
      expect(SessionRowSchema.properties[field]).toBeDefined();
    }
    expect(
      Value.Check(SessionsCreateResultSchema, {
        ok: true,
        key: "agent:main:dashboard:test",
        session: {
          key: "agent:main:dashboard:test",
          kind: "direct",
          thinkingLevel: "xhigh",
          thinkingLevels: [{ id: "xhigh", label: "Extra high" }],
          thinkingOptions: ["Extra high"],
          thinkingDefault: "high",
        },
      }),
    ).toBe(true);
  });
});
