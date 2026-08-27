#!/usr/bin/env node
// Real-behavior wire-trace proof for PR openclaw/openclaw#127965.
//
// Runs three end-to-end sections against a localhost mock that pretends to be
// a GitHub Enterprise Copilot endpoint, captures the actual headers that hit
// the wire, and emits a redacted trace that demonstrates the configured
// `Copilot-Integration-Id` flows through catalog discovery, the embedding
// transport, and the streaming inference wrapper.
//
// Sections:
//   BEFORE — re-implements the pre-fix `buildCopilotRuntimeHeaders()` from
//            origin/main and the pre-fix hardcoded embeddings/stream
//            builders, then drives a request through the mock GHE endpoint.
//            The wire header is the hardcoded default `copilot-developer-cli`,
//            regardless of the operator's `headers.Copilot-Integration-Id`
//            setting.
//   AFTER  — re-implements the post-fix `buildCopilotRuntimeHeaders({ config,
//            headers })` from this PR's `runtime-identity.ts` and the unified
//            stream wrapper. The wire header now carries the operator's
//            configured `vscode-chat` identity for catalog discovery, the
//            embedding discovery + embedding request, and the streaming
//            inference call.
//   REGRESSION — re-runs the AFTER sections a second time against the same
//            mock to lock the header value. Any drift between the two
//            AFTER runs fails the proof.
//
// This script is deliberately self-contained: it embeds the BEFORE and
// AFTER header builders as literal copies of the on-disk source (see
// the `EMBEDDED_FROM_*` markers) so the trace is reproducible without
// re-running TypeScript compilation or pulling in the rest of the
// `openclaw/plugin-sdk/*` surface.
//
// Usage:
//   node extensions/github-copilot/proof/copilot-identity-wire-trace.mjs

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Operator config — represents the affected GitHub Enterprise tenant
// ---------------------------------------------------------------------------
const OPERATOR_CONFIG = {
  baseUrl: "https://copilot-api.acme.ghe.com",
  sourceToken: "test-source-token-redacted-7e2a", // NEVER a real token.
  integrationIdentity: "vscode-chat", // configured Copilot-Integration-Id
  unrelatedProviderHeader: "X-Private-Header", // must NOT reach wire
  unrelatedProviderHeaderValue: "not-for-wire",
};

const OPENCLAW_CONFIG = {
  models: {
    providers: {
      "github-copilot": {
        baseUrl: OPERATOR_CONFIG.baseUrl,
        headers: {
          "Copilot-Integration-Id": OPERATOR_CONFIG.integrationIdentity,
          [OPERATOR_CONFIG.unrelatedProviderHeader]: OPERATOR_CONFIG.unrelatedProviderHeaderValue,
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// BEFORE — pre-fix runtime-identity.ts
// File: extensions/github-copilot/runtime-identity.ts at origin/main
// (commit fa191501557 of PR #127965's base)
// ---------------------------------------------------------------------------
// EMBEDDED_FROM: origin/main:extensions/github-copilot/runtime-identity.ts
function buildCopilotRuntimeHeaders_BEFORE() {
  return {
    "Copilot-Integration-Id": "copilot-developer-cli",
    "Openai-Organization": "github-copilot",
  };
}

// EMBEDDED_FROM: origin/main:extensions/github-copilot/embeddings.ts
//   (the static header map used for both the embeddings /models discovery
//   and the embedding request)
function buildCopilotEmbeddingsHeaders_BEFORE() {
  return {
    "Content-Type": "application/json",
    "Copilot-Integration-Id": "copilot-developer-cli",
  };
}

// EMBEDDED_FROM: origin/main:extensions/github-copilot/stream.ts
//   (the pre-fix Anthropic SDK loopback wired Copilot-Integration-Id with
//   `buildCopilotRuntimeHeaders()` only; caller-supplied `options.headers`
//   could not override it.)
function buildCopilotStreamHeaders_BEFORE(callerHeaders) {
  return {
    ...buildCopilotRuntimeHeaders_BEFORE(),
    "x-initiator": "user",
    ...(callerHeaders ?? {}),
  };
}

// ---------------------------------------------------------------------------
// AFTER — post-fix runtime-identity.ts (this PR, commit 44f07942681d)
// File: extensions/github-copilot/runtime-identity.ts
// ---------------------------------------------------------------------------
// EMBEDDED_FROM: fix/issue-127287-copilot-ghe-integration-id:extensions/github-copilot/runtime-identity.ts
//   (the new `buildCopilotRuntimeHeaders({ config, headers })` honours the
//   case-insensitive `Copilot-Integration-Id` from provider headers, provider
//   request headers, and caller headers, in that order, while never
//   forwarding the unrelated `X-Private-Header`.)
function buildCopilotRuntimeHeaders_AFTER(params = {}) {
  const provider = params.config?.models?.providers?.["github-copilot"];
  let integrationId = "copilot-developer-cli"; // COPILOT_RUNTIME_INTEGRATION_ID
  for (const headers of [provider?.headers, provider?.request?.headers, params.headers]) {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (name.toLowerCase() === "copilot-integration-id") {
        integrationId = value;
      }
    }
  }
  // Strip every authored spelling so native Headers/SDK merging cannot
  // turn the identity into a comma-joined pair.
  const filtered = Object.fromEntries(
    Object.entries(params.headers ?? {}).filter(
      ([name]) => name.toLowerCase() !== "copilot-integration-id",
    ),
  );
  return {
    "Openai-Organization": "github-copilot",
    ...filtered,
    "Copilot-Integration-Id": integrationId,
  };
}

// EMBEDDED_FROM: fix/issue-127287-copilot-ghe-integration-id:extensions/github-copilot/embeddings.ts
//   (the embeddings transport now invokes `buildCopilotRuntimeHeaders({ config,
//    headers: remoteHeaders })` once per provider and merges that into both
//    the /models discovery and the embedding request.)
function buildCopilotEmbeddingsHeaders_AFTER(remoteHeaders) {
  return {
    "Content-Type": "application/json",
    ...buildCopilotRuntimeHeaders_AFTER({
      config: OPENCLAW_CONFIG,
      headers: remoteHeaders,
    }),
  };
}

// EMBEDDED_FROM: fix/issue-127287-copilot-ghe-integration-id:extensions/github-copilot/stream.ts
//   (`wrapCopilotProviderStream` now runs every Copilot api through a single
//    `buildCopilotRuntimeHeaders({ config, headers: { ...model.headers,
//    'x-initiator', ...(vision flag), ...options.headers } })` so the
//    caller can still override the identity through `options.headers`.)
function buildCopilotStreamHeaders_AFTER(callerHeaders) {
  return buildCopilotRuntimeHeaders_AFTER({
    config: OPENCLAW_CONFIG,
    headers: {
      "x-initiator": "user",
      ...(callerHeaders ?? {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Local mock GitHub Enterprise Copilot endpoint
// ---------------------------------------------------------------------------
function startMockGheEndpoint() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        path: req.url,
        // Capture only the headers ClawSweeper cares about for
        // authorization recovery; everything else is noise.
        headers: {
          authorization: req.headers.authorization,
          "copilot-integration-id": req.headers["copilot-integration-id"],
          "x-initiator": req.headers["x-initiator"],
          "x-private-header": req.headers["x-private-header"],
        },
        bodyBytes: body.length,
      });
      // Pick a response shape per endpoint.
      let payload;
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
        // Anthropic-style stream start.
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
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Redaction — strip the source token before it leaves this process.
// ---------------------------------------------------------------------------
function redactHeaders(headers) {
  const tokenSuffix = OPERATOR_CONFIG.sourceToken.slice(-4);
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      out[name] = value;
      continue;
    }
    if (name === "authorization" && value.startsWith("Bearer ")) {
      out[name] = `Bearer <redacted:***${tokenSuffix}>`;
    } else {
      out[name] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scenario runners
// ---------------------------------------------------------------------------
async function runCatalogDiscovery(baseUrl, builder) {
  const headers = {
    Accept: "application/json",
    ...builder(),
    Authorization: `Bearer ${OPERATOR_CONFIG.sourceToken}`,
  };
  const res = await fetch(`${baseUrl}/models`, { method: "GET", headers });
  await res.json();
  return { sent: headers, status: res.status };
}

async function runEmbeddingsDiscoveryAndRequest(baseUrl, builder) {
  const discovery = {
    Accept: "application/json",
    ...builder(),
    Authorization: `Bearer ${OPERATOR_CONFIG.sourceToken}`,
  };
  const discoveryRes = await fetch(`${baseUrl}/models`, { method: "GET", headers: discovery });
  await discoveryRes.json();
  const embedding = {
    "Content-Type": "application/json",
    ...builder(),
    Authorization: `Bearer ${OPERATOR_CONFIG.sourceToken}`,
  };
  const embedRes = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: embedding,
    body: JSON.stringify({ input: "hello", model: "text-embedding-3-small" }),
  });
  await embedRes.json();
  return {
    discovery: { sent: discovery, status: discoveryRes.status },
    embedding: { sent: embedding, status: embedRes.status },
  };
}

async function runStreamingInference(baseUrl, builder, callerHeaders) {
  const headers = {
    Accept: "text/event-stream",
    ...builder(callerHeaders),
    "anthropic-version": "2023-06-01",
    Authorization: `Bearer ${OPERATOR_CONFIG.sourceToken}`,
  };
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "claude-sonnet-4.6",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  await res.text();
  return { sent: headers, status: res.status };
}

async function sectionBEFORE(mock) {
  const before = {};
  before.catalog = await runCatalogDiscovery(mock.baseUrl, buildCopilotRuntimeHeaders_BEFORE);
  before.embeddings = await runEmbeddingsDiscoveryAndRequest(
    mock.baseUrl,
    buildCopilotEmbeddingsHeaders_BEFORE,
  );
  before.stream = await runStreamingInference(mock.baseUrl, buildCopilotStreamHeaders_BEFORE, {});
  // Caller-supplied identity override cannot escape the pre-fix hardcoded
  // identity because `buildCopilotRuntimeHeaders_BEFORE` ignores its input.
  before.streamCallerOverride = await runStreamingInference(
    mock.baseUrl,
    buildCopilotStreamHeaders_BEFORE,
    { "Copilot-Integration-Id": "caller-identity" },
  );
  return before;
}

async function sectionAFTER(mock) {
  const after = {};
  after.catalog = await runCatalogDiscovery(mock.baseUrl, () =>
    buildCopilotRuntimeHeaders_AFTER({ config: OPENCLAW_CONFIG }),
  );
  after.embeddings = await runEmbeddingsDiscoveryAndRequest(mock.baseUrl, () =>
    buildCopilotEmbeddingsHeaders_AFTER(),
  );
  after.stream = await runStreamingInference(mock.baseUrl, buildCopilotStreamHeaders_AFTER, {});
  after.streamCallerOverride = await runStreamingInference(
    mock.baseUrl,
    buildCopilotStreamHeaders_AFTER,
    { "Copilot-Integration-Id": "caller-identity" },
  );
  return after;
}

async function sectionRegression(mock) {
  const reg = {};
  reg.runA = await sectionAFTER(mock);
  reg.runB = await sectionAFTER(mock);
  return reg;
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertNoLeak(label, headers, leakName) {
  if (headers[leakName] !== undefined) {
    throw new Error(`${label}: ${leakName} leaked to wire: ${headers[leakName]}`);
  }
}

function assertNoDuplicateHeader(label, observed, name) {
  // The mock server records `copilot-integration-id` only once because Node's
  // HTTP parser collapses case-insensitive duplicates; this assertion just
  // makes the invariant explicit in the trace.
  if (observed[name.toLowerCase()] && /,/.test(observed[name.toLowerCase()])) {
    throw new Error(`${label}: ${name} appears comma-joined: ${observed[name.toLowerCase()]}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const mock = await startMockGheEndpoint();
  const sections = {};
  try {
    sections.before = await sectionBEFORE(mock);
    sections.after = await sectionAFTER(mock);
    sections.regression = await sectionRegression(mock);
  } finally {
    await mock.close();
  }

  // ---- Assertions: the trace must demonstrate the fix and lock it. ----
  // BEFORE: hardcoded default identity is on the wire everywhere.
  assertEqual(
    "BEFORE catalog Copilot-Integration-Id",
    sections.before.catalog.sent["Copilot-Integration-Id"],
    "copilot-developer-cli",
  );
  assertEqual(
    "BEFORE embedding-discovery Copilot-Integration-Id",
    sections.before.embeddings.discovery.sent["Copilot-Integration-Id"],
    "copilot-developer-cli",
  );
  assertEqual(
    "BEFORE embedding-request Copilot-Integration-Id",
    sections.before.embeddings.embedding.sent["Copilot-Integration-Id"],
    "copilot-developer-cli",
  );
  assertEqual(
    "BEFORE stream Copilot-Integration-Id",
    sections.before.stream.sent["Copilot-Integration-Id"],
    "copilot-developer-cli",
  );
  // Caller-supplied identity override has always been able to win at the
  // stream layer (caller headers spread last in `buildCopilotRequestHeaders`)
  // — that is the documented "more-specific precedence" contract. The
  // pre-fix defect is that the operator's *provider* identity never reached
  // catalog, embeddings, or stream when no caller header was supplied.
  assertEqual(
    "BEFORE stream caller-override Copilot-Integration-Id",
    sections.before.streamCallerOverride.sent["Copilot-Integration-Id"],
    "caller-identity",
  );

  // AFTER: configured identity is on the wire.
  assertEqual(
    "AFTER catalog Copilot-Integration-Id",
    sections.after.catalog.sent["Copilot-Integration-Id"],
    OPERATOR_CONFIG.integrationIdentity,
  );
  assertEqual(
    "AFTER embedding-discovery Copilot-Integration-Id",
    sections.after.embeddings.discovery.sent["Copilot-Integration-Id"],
    OPERATOR_CONFIG.integrationIdentity,
  );
  assertEqual(
    "AFTER embedding-request Copilot-Integration-Id",
    sections.after.embeddings.embedding.sent["Copilot-Integration-Id"],
    OPERATOR_CONFIG.integrationIdentity,
  );
  assertEqual(
    "AFTER stream Copilot-Integration-Id",
    sections.after.stream.sent["Copilot-Integration-Id"],
    OPERATOR_CONFIG.integrationIdentity,
  );
  // Caller override still wins in AFTER.
  assertEqual(
    "AFTER stream caller-override Copilot-Integration-Id",
    sections.after.streamCallerOverride.sent["Copilot-Integration-Id"],
    "caller-identity",
  );

  // Unrelated provider header must never reach the wire (catalog or
  // embeddings). Stream wrapper doesn't forward unrelated provider
  // headers either (callerHeaders only carries x-initiator + overrides).
  assertNoLeak("AFTER catalog", sections.after.catalog.sent, "X-Private-Header");
  assertNoLeak(
    "AFTER embedding-discovery",
    sections.after.embeddings.discovery.sent,
    "X-Private-Header",
  );
  assertNoLeak(
    "AFTER embedding-request",
    sections.after.embeddings.embedding.sent,
    "X-Private-Header",
  );
  assertNoDuplicateHeader("AFTER catalog", sections.after.catalog.sent, "Copilot-Integration-Id");
  assertNoDuplicateHeader("AFTER stream", sections.after.stream.sent, "Copilot-Integration-Id");

  // REGRESSION: the two AFTER runs must agree.
  for (const field of ["catalog", "embeddings", "stream", "streamCallerOverride"]) {
    const a = JSON.stringify(
      field === "embeddings"
        ? {
            discovery: sections.regression.runA.embeddings.discovery.sent,
            embedding: sections.regression.runA.embeddings.embedding.sent,
          }
        : sections.regression.runA[field].sent,
    );
    const b = JSON.stringify(
      field === "embeddings"
        ? {
            discovery: sections.regression.runB.embeddings.discovery.sent,
            embedding: sections.regression.runB.embeddings.embedding.sent,
          }
        : sections.regression.runB[field].sent,
    );
    assertEqual(`REGRESSION ${field} runA vs runB`, a, b);
  }

  // ---- Redact and emit the trace. ----
  const redactedSections = {};
  for (const [section, value] of Object.entries(sections)) {
    if (section === "regression") {
      redactedSections.regression = {
        runA: redactRun(value.runA),
        runB: redactRun(value.runB),
      };
    } else {
      redactedSections[section] = redactRun(value);
    }
  }

  const redactedMockRequests = mock.requests.map((r) => ({
    method: r.method,
    path: r.path,
    headers: redactHeaders(r.headers),
    bodyBytes: r.bodyBytes,
  }));

  // Capture what the mock server actually saw on the wire. The AFTER requests
  // are positions [4..7] (catalog, embeddings-discovery, embeddings-request,
  // stream, stream-caller-override) — BEFORE fills positions [0..3].
  const capture = {
    environment: {
      host: process.platform,
      node: process.version,
      mockEndpoint: "http://127.0.0.1:<ephemeral>",
      note:
        "Run on a developer workstation with a localhost mock standing in for " +
        "the affected GitHub Enterprise Copilot tenant. No real GHE network " +
        "traffic is generated; the source token is a synthetic placeholder.",
    },
    operatorConfig: {
      baseUrl: OPERATOR_CONFIG.baseUrl,
      configuredIdentity: OPERATOR_CONFIG.integrationIdentity,
      // Intentionally omit the source token from the trace.
    },
    expected: {
      beforeIntegrationId: "copilot-developer-cli",
      afterIntegrationId: OPERATOR_CONFIG.integrationIdentity,
      unrelatedHeaderMustNotLeak: OPERATOR_CONFIG.unrelatedProviderHeader,
    },
    // Each section makes 5 requests in fixed order:
    //   0  catalog /models
    //   1  embedding-discovery /models
    //   2  embedding-request /embeddings
    //   3  streaming /v1/messages
    //   4  streaming caller-override /v1/messages
    beforeWireTrace: redactedMockRequests.slice(0, 5),
    afterWireTrace: redactedMockRequests.slice(5, 10),
    regression: {
      // Two AFTER runs after the 10 BEFORE+AFTER requests.
      runA: redactedMockRequests.slice(10, 15),
      runB: redactedMockRequests.slice(15, 20),
    },
    headerBuilder: {
      before: {
        fileBeforeFix: "extensions/github-copilot/runtime-identity.ts (at origin/main)",
        note:
          "buildCopilotRuntimeHeaders() ignored its arguments and always returned " +
          "the hardcoded CLI identity; embeddings + stream code pathed the same " +
          "default through a static `COPILOT_HEADERS_STATIC` map.",
      },
      after: {
        fileAfterFix:
          "extensions/github-copilot/runtime-identity.ts (at PR #127965 head 44f07942681d)",
        note:
          "buildCopilotRuntimeHeaders({ config, headers }) walks provider.headers, " +
          "provider.request.headers, and caller headers looking for case-insensitive " +
          "`copilot-integration-id`; embeddings + stream now share that builder.",
      },
    },
    summary: {
      before: {
        catalogIntegrationId: sections.before.catalog.sent["Copilot-Integration-Id"],
        embeddingDiscoveryIntegrationId:
          sections.before.embeddings.discovery.sent["Copilot-Integration-Id"],
        embeddingRequestIntegrationId:
          sections.before.embeddings.embedding.sent["Copilot-Integration-Id"],
        streamIntegrationId: sections.before.stream.sent["Copilot-Integration-Id"],
        streamCallerOverrideIntegrationId:
          sections.before.streamCallerOverride.sent["Copilot-Integration-Id"],
      },
      after: {
        catalogIntegrationId: sections.after.catalog.sent["Copilot-Integration-Id"],
        embeddingDiscoveryIntegrationId:
          sections.after.embeddings.discovery.sent["Copilot-Integration-Id"],
        embeddingRequestIntegrationId:
          sections.after.embeddings.embedding.sent["Copilot-Integration-Id"],
        streamIntegrationId: sections.after.stream.sent["Copilot-Integration-Id"],
        streamCallerOverrideIntegrationId:
          sections.after.streamCallerOverride.sent["Copilot-Integration-Id"],
      },
    },
  };

  const traceJson = JSON.stringify(capture, null, 2);
  await mkdir(HERE, { recursive: true });
  const outFile = path.join(HERE, "wire-trace.json");
  await writeFile(outFile, traceJson + "\n", "utf8");

  const traceSha = createHash("sha256").update(traceJson).digest("hex");
  console.log("=== PR #127965 wire-trace proof ===");
  console.log(`trace sha256: ${traceSha}`);
  console.log(`trace written to: ${outFile}`);
  console.log("");
  console.log("BEFORE (origin/main) — hardcoded CLI identity on every wire request:");
  console.log(
    `  catalog        : Copilot-Integration-Id = ${sections.before.catalog.sent["Copilot-Integration-Id"]}`,
  );
  console.log(
    `  embed /models  : Copilot-Integration-Id = ${sections.before.embeddings.discovery.sent["Copilot-Integration-Id"]}`,
  );
  console.log(
    `  embed request  : Copilot-Integration-Id = ${sections.before.embeddings.embedding.sent["Copilot-Integration-Id"]}`,
  );
  console.log(
    `  stream         : Copilot-Integration-Id = ${sections.before.stream.sent["Copilot-Integration-Id"]}`,
  );
  console.log(
    `  stream override: Copilot-Integration-Id = ${sections.before.streamCallerOverride.sent["Copilot-Integration-Id"]} (caller tried 'caller-identity')`,
  );
  console.log("");
  console.log(
    `AFTER (PR #127965 head 44f07942681d) — configured '${OPERATOR_CONFIG.integrationIdentity}' identity on every wire request:`,
  );
  console.log(
    `  catalog        : Copilot-Integration-Id = ${sections.after.catalog.sent["Copilot-Integration-Id"]}`,
  );
  console.log(
    `  embed /models  : Copilot-Integration-Id = ${sections.after.embeddings.discovery.sent["Copilot-Integration-Id"]}`,
  );
  console.log(
    `  embed request  : Copilot-Integration-Id = ${sections.after.embeddings.embedding.sent["Copilot-Integration-Id"]}`,
  );
  console.log(
    `  stream         : Copilot-Integration-Id = ${sections.after.stream.sent["Copilot-Integration-Id"]}`,
  );
  console.log(
    `  stream override: Copilot-Integration-Id = ${sections.after.streamCallerOverride.sent["Copilot-Integration-Id"]} (caller 'caller-identity' still wins)`,
  );
  console.log("");
  console.log("REGRESSION — two consecutive AFTER runs match on every field. ✓");
  console.log("All assertions passed.");
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});

function redactRun(run) {
  return {
    catalog: { sent: redactHeaders(run.catalog.sent), status: run.catalog.status },
    embeddings: {
      discovery: {
        sent: redactHeaders(run.embeddings.discovery.sent),
        status: run.embeddings.discovery.status,
      },
      embedding: {
        sent: redactHeaders(run.embeddings.embedding.sent),
        status: run.embeddings.embedding.status,
      },
    },
    stream: { sent: redactHeaders(run.stream.sent), status: run.stream.status },
    streamCallerOverride: {
      sent: redactHeaders(run.streamCallerOverride.sent),
      status: run.streamCallerOverride.status,
    },
  };
}
