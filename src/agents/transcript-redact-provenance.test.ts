// Persistence and replay must agree on redaction provenance (#142821).
//
// This file runs the real persist-side transcript redaction and then the real replay
// projection, so both sides are proven against each other instead of against fixtures.
// Persist wraps every mask it produces; replay rewrites exactly those wrapped spans and
// leaves unmarked bytes alone.
import {
  REDACTION_PROVENANCE_START,
  hasRedactionProvenance,
} from "@openclaw/normalization-core/redaction-provenance";
import { buildSessionContext, type SessionTreeEntry } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

const readLoggingConfig = vi.hoisted(() => vi.fn());

vi.mock("../logging/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/config.js")>();
  return { ...actual, readLoggingConfig };
});

const config = { logging: {} } satisfies OpenClawConfig;
const LONG_SECRET = "plainsecretvalue123";

function toolCallMessage(): ReturnType<typeof castAgentMessage> {
  return castAgentMessage({
    role: "assistant",
    api: "openai-responses",
    provider: "test-provider",
    model: "test-model",
    stopReason: "toolUse",
    timestamp: 0,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [
      {
        type: "toolCall",
        id: "call_1",
        name: "shell",
        arguments: {
          apiKey: LONG_SECRET,
          password: "hunter2",
          command: "OPENAI_API_KEY=sk-abc...0xyz openclaw health",
        },
      },
    ],
  });
}

function replay(entryMessage: unknown): string {
  const entry = {
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "2026-09-02T00:00:00.000Z",
    message: entryMessage,
  } as unknown as SessionTreeEntry;
  return JSON.stringify(buildSessionContext([entry]).messages);
}

describe("transcript persistence writes redaction provenance (#142821)", () => {
  it("marks every mask it stores and keeps the secret out of the transcript", () => {
    readLoggingConfig.mockReturnValue({});
    const stored = JSON.stringify(redactTranscriptMessage(toolCallMessage(), config));
    expect(stored).toContain(REDACTION_PROVENANCE_START);
    expect(stored).not.toContain(LONG_SECRET);
    expect(stored).not.toContain("hunter2");
  });

  it("does not mark a message it did not change", () => {
    readLoggingConfig.mockReturnValue({});
    const benign = castAgentMessage({
      role: "user",
      content: "the file is here…world of pain",
      timestamp: 0,
    });
    const stored = redactTranscriptMessage(benign, config);
    expect(stored).toBe(benign);
    expect(hasRedactionProvenance(JSON.stringify(stored))).toBe(false);
  });

  it("leaves an already marked mask intact when redaction runs twice", () => {
    readLoggingConfig.mockReturnValue({});
    const once = redactTranscriptMessage(toolCallMessage(), config);
    const twice = redactTranscriptMessage(once, config);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});

describe("replay consumes that provenance (#142821)", () => {
  it("swaps persisted masks for a re-derive placeholder and keeps surrounding text", () => {
    readLoggingConfig.mockReturnValue({});
    const stored = redactTranscriptMessage(toolCallMessage(), config);
    const replayed = replay(stored);
    expect(replayed).toContain("re-derive");
    expect(replayed).not.toContain(REDACTION_PROVENANCE_START);
    expect(replayed).not.toContain(LONG_SECRET);
    // The assignment prefix around the embedded mask survives.
    expect(replayed).toContain("OPENAI_API_KEY=");
    expect(replayed).toContain("openclaw health");
  });

  it("leaves literal history alone even when it looks exactly like a mask", () => {
    readLoggingConfig.mockReturnValue({});
    const legacy = castAgentMessage({
      role: "assistant",
      api: "openai-responses",
      provider: "test-provider",
      model: "test-model",
      stopReason: "toolUse",
      timestamp: 0,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "shell",
          arguments: { command: "value=sk-bug…9f3a", note: "***", rule: "***\n---" },
        },
      ],
    });
    const replayed = replay(legacy);
    expect(replayed).toContain("value=sk-bug…9f3a");
    expect(replayed).toContain('"***"');
    expect(replayed).not.toContain("re-derive");
  });
});
