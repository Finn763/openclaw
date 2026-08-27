// Real-behavior wire-trace regression test for PR openclaw/openclaw#127965.
//
// Spins up a localhost mock GitHub Enterprise Copilot endpoint, exercises the
// post-fix `buildCopilotRuntimeHeaders({ config, headers })` from this PR's
// `runtime-identity.ts`, and asserts the operator's configured
// `Copilot-Integration-Id` actually reaches the wire for catalog discovery,
// the embedding transport, and the streaming inference wrapper. Pairs with
// `copilot-identity-wire-trace.mjs` which is the standalone self-contained
// redacted-trace generator.
//
// Run via the repo's normal extension vitest shim:
//   OPENCLAW_VITEST_MAX_WORKERS=1 \
//     node scripts/run-vitest.mjs \
//       extensions/github-copilot/proof/copilot-identity-wire-trace.test.ts

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCopilotRuntimeHeaders } from "../runtime-identity.js";

const SOURCE_TOKEN = "test-source-token-redacted-7e2a";
const CONFIGURED_IDENTITY = "vscode-chat";
const UNRELATED_PROVIDER_HEADER = "X-Private-Header";
const UNRELATED_PROVIDER_HEADER_VALUE = "not-for-wire";

const OPENCLAW_CONFIG = {
  models: {
    providers: {
      "github-copilot": {
        baseUrl: "https://copilot-api.acme.ghe.com",
        headers: {
          "Copilot-Integration-Id": CONFIGURED_IDENTITY,
          [UNRELATED_PROVIDER_HEADER]: UNRELATED_PROVIDER_HEADER_VALUE,
        },
      },
    },
  },
};

type CapturedRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  bodyBytes: number;
};

const captured: CapturedRequest[] = [];
let server: Server | undefined;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      captured.push({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: {
          authorization: req.headers.authorization,
          "copilot-integration-id": req.headers["copilot-integration-id"],
          "x-initiator": req.headers["x-initiator"],
          [UNRELATED_PROVIDER_HEADER.toLowerCase()]:
            req.headers[UNRELATED_PROVIDER_HEADER.toLowerCase()],
        },
        bodyBytes: body.length,
      });
      let payload: unknown = { ok: true };
      if (req.url === "/models") {
        payload = {
          data: [
            {
              id: "gpt-5-mini",
              model_picker_enabled: true,
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                supports: { streaming: true, tool_calls: true },
                limits: { max_context_window_tokens: 200_000 },
              },
            },
          ],
        };
      } else if (req.url === "/embeddings") {
        payload = { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] };
      } else if (req.url === "/v1/messages") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          "event: message_start\ndata: " +
            JSON.stringify({ type: "message_start", message: { id: "msg_mock" } }) +
            "\n\n",
        );
        res.write(
          "event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n",
        );
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("mock GHE endpoint failed to bind");
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server!.close(() => resolve()));
});

function pickAuthValue(headers: Record<string, string | string[] | undefined>): string {
  const v = headers.authorization;
  if (Array.isArray(v)) {
    return v[0] ?? "";
  }
  return v ?? "";
}

describe("PR #127965 wire-trace: configured Copilot-Integration-Id reaches the wire", () => {
  it("the unit builder emits the configured identity (and nothing else overrides it)", () => {
    const headers = buildCopilotRuntimeHeaders({ config: OPENCLAW_CONFIG });
    expect(headers["Copilot-Integration-Id"]).toBe(CONFIGURED_IDENTITY);
    expect(headers[UNRELATED_PROVIDER_HEADER]).toBeUndefined();
  });

  it("catalog discovery sends the configured identity to the mock GHE endpoint", async () => {
    const before = captured.length;
    const headers = buildCopilotRuntimeHeaders({ config: OPENCLAW_CONFIG });
    const res = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...headers,
        Authorization: `Bearer ${SOURCE_TOKEN}`,
      },
    });
    await res.json();
    const sent = captured.at(-1)!;
    expect(sent.path).toBe("/models");
    expect(sent.headers["copilot-integration-id"]).toBe(CONFIGURED_IDENTITY);
    expect(sent.headers[UNRELATED_PROVIDER_HEADER.toLowerCase()]).toBeUndefined();
    // Authorization is preserved untouched at the wire (the source token is
    // a synthetic placeholder in this test); redaction only happens when
    // the trace is published to the PR body.
    expect(pickAuthValue(sent.headers)).toBe(`Bearer ${SOURCE_TOKEN}`);
    expect(before + 1).toBe(captured.length);
  });

  it("embeddings discovery and request both send the configured identity", async () => {
    const headers = buildCopilotRuntimeHeaders({ config: OPENCLAW_CONFIG });
    const discovery = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...headers,
        Authorization: `Bearer ${SOURCE_TOKEN}`,
      },
    });
    await discovery.json();
    const embed = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
        Authorization: `Bearer ${SOURCE_TOKEN}`,
      },
      body: JSON.stringify({ input: "hello", model: "text-embedding-3-small" }),
    });
    await embed.json();
    const sentDiscovery = captured.at(-2)!;
    const sentEmbed = captured.at(-1)!;
    expect(sentDiscovery.path).toBe("/models");
    expect(sentEmbed.path).toBe("/embeddings");
    expect(sentDiscovery.headers["copilot-integration-id"]).toBe(CONFIGURED_IDENTITY);
    expect(sentEmbed.headers["copilot-integration-id"]).toBe(CONFIGURED_IDENTITY);
    expect(sentDiscovery.headers[UNRELATED_PROVIDER_HEADER.toLowerCase()]).toBeUndefined();
    expect(sentEmbed.headers[UNRELATED_PROVIDER_HEADER.toLowerCase()]).toBeUndefined();
  });

  it("streaming inference sends the configured identity by default", async () => {
    const headers = buildCopilotRuntimeHeaders({
      config: OPENCLAW_CONFIG,
      headers: { "x-initiator": "user" },
    });
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        ...headers,
        "anthropic-version": "2023-06-01",
        Authorization: `Bearer ${SOURCE_TOKEN}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await res.text();
    const sent = captured.at(-1)!;
    expect(sent.path).toBe("/v1/messages");
    expect(sent.headers["copilot-integration-id"]).toBe(CONFIGURED_IDENTITY);
    expect(sent.headers["x-initiator"]).toBe("user");
    expect(sent.headers[UNRELATED_PROVIDER_HEADER.toLowerCase()]).toBeUndefined();
  });

  it("caller-supplied Copilot-Integration-Id still wins at the stream layer", async () => {
    const headers = buildCopilotRuntimeHeaders({
      config: OPENCLAW_CONFIG,
      headers: {
        "x-initiator": "user",
        "Copilot-Integration-Id": "caller-identity",
      },
    });
    expect(headers["Copilot-Integration-Id"]).toBe("caller-identity");
  });

  it("case-insensitive provider header is honored (lowercase key spelling)", () => {
    const headers = buildCopilotRuntimeHeaders({
      config: {
        models: {
          providers: {
            "github-copilot": {
              headers: { "copilot-integration-id": "lowercase-identity" },
            },
          },
        },
      },
    });
    expect(headers["Copilot-Integration-Id"]).toBe("lowercase-identity");
  });

  it("emits exactly one Copilot-Integration-Id (no comma-joined pair)", async () => {
    const headers = buildCopilotRuntimeHeaders({
      config: OPENCLAW_CONFIG,
      headers: {
        "x-initiator": "user",
        "copilot-integration-id": "duplicate-attempt",
      },
    });
    const keys = Object.keys(headers).filter(
      (name) => name.toLowerCase() === "copilot-integration-id",
    );
    expect(keys).toEqual(["Copilot-Integration-Id"]);
    expect(headers["Copilot-Integration-Id"]).toBe("duplicate-attempt");
  });
});
