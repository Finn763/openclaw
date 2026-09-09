## What Problem This Solves

A Telegram turn can finish all requested work and still leave the user with only the progress message. When the terminal `message(action="send", final=true)` returns `{status: "delivery_ambiguous", delivered: false, message: "The completed reply may already have been delivered. Do not retry it."}`, no outbound receipt follows, the model's fallback final stays internal, and the run is recorded as successful — silent message loss (#128971).

This PR closes that hole in two layers:

1. The reply-admission owner (`runReplyAgent`) stops steering an inbound into a live run whose terminal source-reply delivery state is fail-closed; the inbound falls through to the active-run queue policy and is drained as the next ordered turn.
2. The gateway fences terminal-receipt admission **at the injection-start boundary**: `createChatSendMessageInjectionStarter` revalidates the latest persisted session entry *before* `beginReplyMessageInjectionTarget` synchronously queues the steer with the target runtime. A fail-closed entry rejects the injection before anything is enqueued, so the inbound falls back to follow-up dispatch — it can never become a queued steer plus a second dispatch (inbound double delivery).

## Root cause

Two contracts interact:

1. The terminal source-reply receipt is fail-closed by design: once a source turn owns a terminal delivery state (receipt `terminal-pending` / `delivered-terminal`, an unresolved terminal tool-call id, a terminal-source tombstone, or a stale claim), `beginTerminalSourceReplyDelivery` refuses any further terminal send on that source turn with `delivery_ambiguous` / `already_delivered` and "Do not retry it" (`src/infra/outbound/source-reply-mirror.ts`, `src/config/sessions/restart-recovery-receipt.ts`, `src/infra/outbound/message-action-execution.ts`). The receipt is at-most-once by contract: it is never retried, cleared, or weakened.
2. The message-action turn capability is minted once per run with `toolContext.currentSourceTurnId`, so every message-tool send inside that run — including sends from a later steered inbound — resolves to the same source-turn delivery claim.

An inbound arriving while the active turn holds a terminal delivery state used to be accepted as a steer into the live turn (same run capability, same source-turn claim), and the steered request's terminal send then hit the fail-closed owner and returned `delivery_ambiguous` — silent loss.

The first fix attempt fenced steering inside the gateway's finalizer (`finalizeAcceptedChatSendMessageInjection`). That was too late: `beginReplyMessageInjectionTarget` already synchronously called the target runtime's `queueMessage` before the finalizer ever ran, so a finalizer rejection could not un-enqueue the steer — the original silent-loss race stayed reachable, and the fallback second dispatch produced inbound double delivery. This revision moves the fence to the only point that can actually prevent the enqueue.

## Fix

- `src/gateway/server-methods/chat-send-message-injection.ts`: the terminal-delivery admission fence moves from the post-injection finalizer into `createChatSendMessageInjectionStarter`, i.e. **before** `beginReplyMessageInjectionTarget` queues the message. The starter revalidates the latest persisted entry (`readConsistency: "latest"`) and rejects with `undefined` when it fail-closes terminal delivery, falling back to the captured entry only when the reload fails or nothing is persisted yet. The finalizer no longer fenced post-enqueue; its remaining `false` path is the runtime refusing the queued steer (nothing enqueued → safe fallback). Net production diff tightens the previous post-injection guard into the front admission fence.
- `src/gateway/server-methods/chat-send-handler.ts`: passes `sessionKey` / `storePath` / `clientRunId` / `logGateway` into the starter so the fence can reload and log.
- `src/config/sessions/restart-recovery-receipt.ts`: unchanged from the previous revision — the send path and the fence share the single `resolveRestartRecoveryTerminalDeliveryDisposition` classification surface (`isRestartRecoveryTerminalDeliveryFailClosed`).
- `src/auto-reply/reply/agent-runner-run.ts`: unchanged from the previous revision — the runner's own steer fence still promotes an inbound to the next ordered turn when the active turn is fail-closed (the authoritative safety net for the residual window between the gateway fence and runtime acceptance).

Invariant matrix (verified by tests):

| active entry state             | gateway injection | inbound disposition |
| ------------------------------ | ----------------- | ------------------- |
| no receipt / startable claim   | queued (steer)    | steer (unchanged)   |
| `terminal-pending`             | rejected pre-queue| follow-up turn      |
| `delivered-terminal`           | rejected pre-queue| follow-up turn      |
| terminal tool-call id only     | rejected pre-queue| follow-up turn      |
| terminal-source tombstone      | rejected pre-queue| follow-up turn      |
| stale claim                    | rejected pre-queue| follow-up turn      |
| receipt committed between dispatch and injection start | rejected pre-queue | follow-up turn |
| receipt committed after runtime queue acceptance | — | runtime admission owns it (runner fence) |

Fail-closed custody is preserved: the ambiguous receipt is never retried, cleared, or weakened.

## Tests

- `src/gateway/server-methods/chat-send-message-injection.test.ts`: new `createChatSendMessageInjectionStarter admission fence` suite exercises the full ordering — starter creation → synchronous `queueMessage` (via `beginReplyMessageInjectionTarget`) → latest-state revalidation: rejection before queueing when the latest persisted entry fail-closes terminal delivery; rejection on the captured fail-closed entry; latest-entry-wins over the stale snapshot; reload-failure fallback to the captured entry; queueing when the latest entry is startable. A mock-gateway contract case proves a fail-closed inbound routes to follow-up dispatch exactly once with zero steer enqueues. The finalizer revalidation cases from the previous revision are replaced by these front-fence cases.
- `src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts`: the runner-side queue-instead-of-steer cases for all four fail-closed entry states and the accepted-as-steer promotion remain green.
- `src/config/sessions/restart-recovery-receipt.test.ts`: locks the classification mapping (unchanged).

- Pre-fix (54cdd8032): the five new front-fence cases fail exactly as predicted — the starter enqueues the steer (`beginReplyMessageInjectionTarget` called with the steering payload) even though the latest persisted entry fail-closes terminal delivery, and the contract case observes the enqueued steer instead of the single follow-up dispatch.
- Post-fix: they pass — the starter returns `undefined` before queueing, `beginReplyMessageInjectionTarget` is never invoked, and exactly one follow-up dispatch delivers the inbound.

## Evidence

All evidence below is from this PR's branch run on the same in-repo harnesses CI uses; account/channel identifiers are omitted (redacted).

**Red → green (front fence).** Against the pre-fix head (`54cdd8032`), the five new injection-start fence cases fail exactly as predicted:

```text
 FAIL  chat-send-message-injection.test.ts > createChatSendMessageInjectionStarter admission fence > rejects the injection before queueing when the latest persisted entry fail-closes terminal delivery
 FAIL  chat-send-message-injection.test.ts > createChatSendMessageInjectionStarter admission fence > rejects before queueing when the captured entry itself fail-closes terminal delivery
 FAIL  chat-send-message-injection.test.ts > createChatSendMessageInjectionStarter admission fence > follows the latest persisted entry over the stale captured snapshot
 FAIL  chat-send-message-injection.test.ts > createChatSendMessageInjectionStarter admission fence > falls back to the captured entry when the latest reload fails
 FAIL  chat-send-message-injection.test.ts > gateway steer contract after the injection-start fence > routes a fail-closed inbound to follow-up dispatch exactly once, with no steer enqueued
 Test Files  1 failed (1) — Tests 5 failed | 3 passed (8)
```

The failure detail for the ordering case shows the old code enqueueing the doomed steer: `beginReplyMessageInjectionTarget` was called with `("steer", {steeringMode: "all", isInboundUserMessage: true, …})` — number of calls: 1 — i.e. `queueMessage` had already run before any terminal-receipt revalidation could refuse it.

With the front fence, the whole file is green:

```text
 ✓ createChatSendMessageInjectionStarter admission fence > rejects the injection before queueing when the latest persisted entry fail-closes terminal delivery
 ✓ createChatSendMessageInjectionStarter admission fence > rejects before queueing when the captured entry itself fail-closes terminal delivery
 ✓ createChatSendMessageInjectionStarter admission fence > follows the latest persisted entry over the stale captured snapshot
 ✓ createChatSendMessageInjectionStarter admission fence > falls back to the captured entry when the latest reload fails
 ✓ createChatSendMessageInjectionStarter admission fence > queues the steer when the latest persisted entry is startable
 ✓ gateway steer contract after the injection-start fence > routes a fail-closed inbound to follow-up dispatch exactly once, with no steer enqueued
 ✓ finalizeAcceptedChatSendMessageInjection > audits a confirmed steer as completed active_run_injected
 ✓ finalizeAcceptedChatSendMessageInjection > audits an unconfirmed-transcript steer abort as skipped, not completed
 Test Files  1 passed (1) — Tests 8 passed (8)
```

**Mock-gateway verdict (fail-closed → exactly one visible follow-up reply, zero steer enqueues).** The gateway contract case drives the real starter closure through the mock gateway: a Telegram-session inbound whose latest persisted entry holds a `terminal-pending` receipt is rejected at the injection-start boundary — `beginReplyMessageInjectionTarget` (the synchronous `queueMessage` boundary) is **not** called, so no steer is ever enqueued — and the follow-up dispatch path is taken exactly once, producing one visible reply instead of a steer plus a second dispatch. The runner-side e2e verdict from the previous revision is unchanged: for every fail-closed active entry state the inbound is not steered into the live run (`queueEmbeddedAgentMessageMock` / `runEmbeddedAgentMock` not called) and `enqueueFollowupRun` is called once with `runState.admission === {status: "accepted", mode: "followup"}`.

**Static gates.** `oxfmt --check` clean, oxlint clean, and `node scripts/check-changed.mjs -- <changed files>` green for every lane.

**Windows teardown noise (environment, not this PR).** `restart-recovery-receipt.test.ts` reports 8 failures on this host; all 8 are `EPERM, Permission denied` on `%TEMP%\restart-receipt-*` temp-dir cleanup with zero assertion failures. Verified identical on the untouched pre-fix head (`git stash` → same 8 EPERM, same 9 passes), matching the same noise class documented for the previous revision; CI runs Linux. The full e2e file run on this host reports `Tests 133 failed | 30 passed (163)`; all 133 failures are `EPERM`/`EBUSY` temp-dir file-lock teardown noise (137 `FAIL` markers, 149 EPERM/EBUSY error lines, **zero** `AssertionError`), identical to the previous revision's baseline. All 7 PR steering/receipt cases pass in that run (terminal-pending / delivered-terminal receipts, terminal-source tombstone, unresolved terminal tool-call id, stale claim, privilege mismatch, and the accepted-as-steer promotion), and the gateway unit suite is fully green.

**Live Telegram trace.** A live bot trace could not be produced in this environment (no Telegram bot account attached to this host); the deterministic mock-gateway verdict above is the strongest after-fix behavior proof available here.

## Notes / exclusions

- The change is entirely OpenClaw-side; no Codex internals are asserted or modified.
- The runner-side fence (`agent-runner-run.ts`) is intentionally left as the authoritative safety net for the residual window between the gateway fence and the runtime's own synchronous admission check.

Closes #128971
