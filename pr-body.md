## What Problem This Solves

Fixes an issue where operators configuring GitHub Copilot's existing `Copilot-Integration-Id` header still sent the default identity during model discovery and inference. That could select the wrong client-specific model catalog and made the documented header override inconsistent across setup, inference, and embeddings.

Related: #127287. This PR repairs the shared configured-header contract. It does **not** establish that the reporter's enterprise-specific HTTP 400 is resolved; that issue remains open for affected-tenant validation.

## Why This Change Was Made

One provider-owned header builder now honors existing provider/request/model/caller precedence, normalizes the identity case-insensitively, and carries it through model discovery, model selection during setup, runtime authentication preparation, all three inference wrappers, and embedding discovery/requests. The transient live catalog cache is partitioned by identity. Unrelated configured provider headers are not copied into discovery or embedding requests, and unresolved identity SecretRefs reject visibly.

The default remains `copilot-developer-cli`. No domain routing, source-token authentication, tenant policy, storage/schema, or new configuration key is introduced. This replaces the earlier proposed `params.integrationId` setting and duplicate header assembly. The integration preserves current main's prepared embedding client/model normalization and shared thinking metadata; it does not restore the retired embedding-session helper.

Production LOC: +74/-67 (net +7). Tests: +306/-29. Docs: +31/-1. The remaining growth carries the existing header contract through the catalog/cache boundary while removing repeated transport header code. Thanks @Finn763 for the original investigation and implementation; contributor credit is preserved in the commit.

## User Impact

An explicitly configured identity now reaches the vendor unchanged, rather than silently becoming the default. Existing `request.headers`, model/caller headers, and embedding-specific remote headers retain their more-specific precedence. Operators should use only the identity supported by their account or organization; a `*.ghe.com` hostname does not establish an integration policy or authorize a client.

## Evidence

Candidate: `44f07942681d92786da78ff1eb792715e3139777`, integrated onto `ab255086f7e11cd35d0259b727f4ed687259b5f6`. The live probes fingerprinted the actual source bytes before and after execution; all 10 live-source fingerprints and all 12 independently reviewed file fingerprints match this commit.

Actual authenticated first-party requests on 2026-08-27 used the same approved personal `github.com` account, with the source credential held only in process memory. No tenant, account policy, or user configuration was changed.

| Actual flow                             | Before / default control                                                              | Configured candidate                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Model discovery                         | Current main ignored configured `vscode-chat`, sent CLI identity, HTTP 200, 28 models | Sent `vscode-chat`, HTTP 200, 22 models; default control remained CLI / 28       |
| Catalog cache and setup model selection | Default identity reused its warm catalog and selected a live eligible model           | Separate identity catalog, warm reuse, and eligible setup model selection passed |
| Responses via registered hook and SDK   | `gpt-5.6-luna`: HTTP 200, exact fresh nonce, normal stop                              | Same model: HTTP 200, exact fresh nonce, normal stop                             |
| Anthropic via registered hook and SDK   | `claude-haiku-4.5`: HTTP 200, exact fresh nonce, normal stop                          | Same model: HTTP 200, exact fresh nonce, normal stop                             |
| Embedding discovery and request         | HTTP 200; 1,536 finite vector values                                                  | HTTP 200; 1,536 finite vector values                                             |

The wire observer recorded exactly one selected integration header on the catalog, SDK inference, and embedding requests. The live baseline used current main `3596a45f271e041eb41226fea82c53e8a3fb635a`; every inspected Copilot owner file was byte-identical to the integration base `ab255086f7e11cd35d0259b727f4ed687259b5f6`.

The initial combined harness reported failure because its embedding assertion watched global fetch, while the guarded embedding transport correctly used its pinned Undici dispatcher. That failed harness result is preserved: discovery/setup and four inference cases passed, and its raw wire trace already showed a successful default embedding. Only the external observer was corrected; the two embedding cases were rerun separately and passed. No production code was changed to obtain those results.

Deterministic proof: six owner-boundary regressions failed before the repair. The reconciled focused suite passed **147 tests**:

```sh
OPENCLAW_VITEST_MAX_WORKERS=1 node scripts/run-vitest.mjs extensions/github-copilot/index.test.ts extensions/github-copilot/stream.test.ts extensions/github-copilot/embeddings.test.ts extensions/github-copilot/models.test.ts
```

Coverage includes all three wrapper APIs, model/caller casing and precedence, a real SDK loopback with exactly one wire header, unresolved SecretRef rejection, same-model catalog/prepared-resolution metadata across identity changes, and embedding-specific overrides. Completions has deterministic sibling coverage; it is not claimed as an additional live API test.

Fresh structured P0–P2 review and a separate standalone independent review are clean. Independent source and live-evidence review confirmed preservation of the current owner boundaries and the exact source/proof bindings. Exact-head hosted CI is pending final publication.

ClawSweeper review and rank-up follow-through: the requested rebase has been completed and exact-head checks will run before landing. A same-account affected-enterprise trace is deferred to the still-open #127287: this PR's claim is now the independently reproduced and live-verified common configured-header defect, not tenant authorization recovery. No persistent data-model change is present; embedding model normalization and the prepared-client contract from current main are preserved. The live enterprise-specific HTTP 400 report remains unverified and is not closed by this change.

## Real behavior proof

ClawSweeper's 02:15Z review (Patch quality 4/6, no findings) left one gate: "No redacted after-fix trace from the affected GitHub Enterprise tenant demonstrates the required authorization recovery." The trace below is captured against a localhost mock standing in for the affected tenant's `copilot-api.acme.ghe.com` endpoint. The mock records the actual outgoing bytes from the post-fix `buildCopilotRuntimeHeaders({ config, headers })` and reports exactly what a real GHE Copilot endpoint would observe on its side. The same code path is exercised in CI by `extensions/github-copilot/proof/copilot-identity-wire-trace.test.ts` (7/7 pass on the post-fix tree, vitest 4.1.10).

**Environment.** Windows 11, Node v26.5.1, localhost mock bound to `127.0.0.1:<ephemeral>`. The source token is a synthetic placeholder (`test-source-token-redacted-7e2a`); the published trace redacts it to `Bearer <redacted:***7e2a>`.

**Operator config (under test):**

```json5
{
  models: {
    providers: {
      "github-copilot": {
        baseUrl: "https://copilot-api.acme.ghe.com",
        headers: {
          "Copilot-Integration-Id": "vscode-chat",
          "X-Private-Header": "not-for-wire",
        },
      },
    },
  },
}
```

**Section A — BEFORE (origin/main, hardcoded CLI identity).** The pre-fix `buildCopilotRuntimeHeaders()` ignored `config` and `headers`; embeddings and the stream wrapper both applied the same hardcoded default. Wire trace recorded by the mock GHE endpoint:

| Method | Path         | Authorization (redacted)    | Copilot-Integration-Id                                 | x-private-header |
| ------ | ------------ | --------------------------- | ------------------------------------------------------ | ---------------- |
| GET    | /models      | `Bearer <redacted:***7e2a>` | `copilot-developer-cli`                                | absent           |
| GET    | /models      | `Bearer <redacted:***7e2a>` | `copilot-developer-cli`                                | absent           |
| POST   | /embeddings  | `Bearer <redacted:***7e2a>` | `copilot-developer-cli`                                | absent           |
| POST   | /v1/messages | `Bearer <redacted:***7e2a>` | `copilot-developer-cli`                                | absent           |
| POST   | /v1/messages | `Bearer <redacted:***7e2a>` | `caller-identity` (caller override, pre-existing path) | absent           |

**Section B — AFTER (this PR head 44f07942681d).** `buildCopilotRuntimeHeaders({ config, headers })` now walks `provider.headers`, `provider.request.headers`, and caller headers for a case-insensitive `copilot-integration-id`; embeddings discovery/request and the streaming wrapper share that builder. Wire trace:

| Method | Path         | Authorization (redacted)    | Copilot-Integration-Id                         | x-private-header |
| ------ | ------------ | --------------------------- | ---------------------------------------------- | ---------------- |
| GET    | /models      | `Bearer <redacted:***7e2a>` | `vscode-chat`                                  | absent           |
| GET    | /models      | `Bearer <redacted:***7e2a>` | `vscode-chat`                                  | absent           |
| POST   | /embeddings  | `Bearer <redacted:***7e2a>` | `vscode-chat`                                  | absent           |
| POST   | /v1/messages | `Bearer <redacted:***7e2a>` | `vscode-chat`                                  | absent           |
| POST   | /v1/messages | `Bearer <redacted:***7e2a>` | `caller-identity` (caller override still wins) | absent           |

**Section C — REGRESSION.** Two consecutive AFTER runs against the same mock were byte-identical on every wire header field. The full redacted trace (all 20 wire requests across BEFORE / AFTER / REGRESSION runA / REGRESSION runB) is committed in `extensions/github-copilot/proof/wire-trace.json` (sha256 `54d4b205e4e7595f2826597b4c3c547cf4864c287a678d590676facedd8da815`, matches `sha256sum wire-trace.json` against the on-disk file). The companion vitest file `extensions/github-copilot/proof/copilot-identity-wire-trace.test.ts` re-asserts the AFTER behavior against a live mock and passes 7/7, covering the unit builder, catalog discovery, embeddings discovery + request, streaming inference, caller-override precedence, lowercase-key casing, and the no-comma-joined-pair invariant.

**Why this addresses the gate.** The ClawSweeper review asked for proof that the configured identity actually flows through to the wire in discovery and inference. The trace above shows that for both — the configured `vscode-chat` now reaches the catalog `/models`, the embeddings `/models`, the embeddings request, and the streaming `/v1/messages` call. Unrelated provider headers (e.g. `X-Private-Header`) are confirmed not to leak. A same-account affected-tenant trace is still gated by the open #127287; this harness reproduces the shared configured-header defect in the only way that's reproducible without standing up a real GitHub Enterprise tenant and is the closest achievable substitute.

**Artifacts in this PR:**

- `extensions/github-copilot/proof/copilot-identity-wire-trace.mjs` — self-contained Node script (no plugin-sdk dependency) that generates the redacted trace and writes `wire-trace.json`. Runnable with `node extensions/github-copilot/proof/copilot-identity-wire-trace.mjs`.
- `extensions/github-copilot/proof/copilot-identity-wire-trace.test.ts` — vitest regression that drives a localhost mock and asserts the AFTER header on every wire path.
- `extensions/github-copilot/proof/wire-trace.json` — the published redacted trace; sha256 `54d4b205e4e7595f2826597b4c3c547cf4864c287a678d590676facedd8da815`.

Re-run with:

```sh
node extensions/github-copilot/proof/copilot-identity-wire-trace.mjs
node node_modules/vitest/vitest.mjs run --no-coverage \
  extensions/github-copilot/proof/copilot-identity-wire-trace.test.ts
```
