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

- `src/gateway/server-methods/chat-send-message-injection.ts`: the terminal-delivery admission fence moves from the post-injection finalizer into `createChatSendMessageInjectionStarter`, i.e. **before** `beginReplyMessageInjectionTarget` queues the message. The starter revalidates the latest persisted entry (`readConsistency: "latest"`) and rejects with `undefined` when it fail-closes terminal delivery, falling back to the captured entry only when the reload fails or nothing is persisted yet. The finalizer no longer fenced post-enqueue; its remaining `false` path is the runtime refusing the queued steer (nothing enqueued → safe fallback).
- `src/config/sessions/restart-recovery-receipt.ts`: the shared fail-closed classifier `isRestartRecoveryTerminalDeliveryFailClosed` now takes the **active source-turn identity** and scopes the terminal-tombstone condition to that exact source: `hasRestartRecoveryTerminalRun(entry, sourceTurnId)` instead of `hasAnyRestartRecoveryTerminalRun(entry)`. Terminal run ids are accumulated session history, so an unrelated prior tombstone no longer forces a safe steer into follow-up mode, while the same-source tombstone still fail-closes (the send path resolves it to `already-delivered`).
- `src/auto-reply/reply/agent-runner-execute.ts` + `reply-run-registry.*`: the owning runner records the active source-turn identity on the registry (`replyRunRegistry.bindSourceTurnId`) when it admits its delivery claim, and `resolveCurrentMessageInjectionTarget` carries it on the injection target (`sourceTurnId`). This gives the gateway admission path the identity it needs even after claim cleanup, when the entry no longer names a claim source.
- `src/auto-reply/reply/agent-runner-run.ts`: the runner's own steer fence now compares against the registry-recorded active source-turn identity (falling back to the entry's claim source), so it accepts an unrelated-tombstone steer and only promotes the inbound to the next ordered turn when the active source itself is fail-closed. This remains the authoritative safety net for the residual window between the gateway fence and runtime acceptance.
- `src/gateway/server-methods/chat-send-handler.ts`: passes `sessionKey` / `storePath` / `clientRunId` / `logGateway` into the starter so the fence can reload and log.

Invariant matrix (verified by tests):

| active entry state             | gateway injection | inbound disposition |
| ------------------------------ | ----------------- | ------------------- |
| no receipt / startable claim   | queued (steer)    | steer (unchanged)   |
| `terminal-pending`             | rejected pre-queue| follow-up turn      |
| `delivered-terminal`           | rejected pre-queue| follow-up turn      |
| terminal tool-call id only     | rejected pre-queue| follow-up turn      |
| tombstone on the **active source turn** | rejected pre-queue | follow-up turn |
| tombstone on an **unrelated earlier source** | queued (steer) | steer |
| stale claim                    | rejected pre-queue| follow-up turn      |
| receipt committed between dispatch and injection start | rejected pre-queue | follow-up turn |
| receipt committed after runtime queue acceptance | — | runtime admission owns it (runner fence) |

Fail-closed custody is preserved: the ambiguous receipt is never retried, cleared, or weakened.

## Tests

- `src/gateway/server-methods/chat-send-message-injection.test.ts`: the `createChatSendMessageInjectionStarter admission fence` suite exercises the full ordering — starter creation → synchronous `queueMessage` (via `beginReplyMessageInjectionTarget`) → latest-state revalidation: rejection before queueing when the latest persisted entry fail-closes terminal delivery; rejection on the captured fail-closed entry; latest-entry-wins over the stale snapshot; reload-failure fallback to the captured entry; queueing when the latest entry is startable. Two new source-scope cases: the steer is **queued** when the latest entry holds only an unrelated historical tombstone, and **rejected before queueing** when the latest entry tombstones the active source turn itself.
- `src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts`: the runner-side queue-instead-of-steer cases for all four fail-closed entry states and the accepted-as-steer promotion remain green. New: a steer is accepted while the retained terminal-source tombstone belongs to an unrelated prior source turn.
- `src/config/sessions/restart-recovery-receipt.test.ts`: locks the classification mapping and the new source-scope semantics — same-source tombstone fail-closes; an unrelated tombstone on a claimless entry does not; an unknown active source mirrors the send path's `not-applicable` arming behavior.

- Pre-fix: the five new front-fence cases fail exactly as predicted — the starter enqueues the steer even though the latest persisted entry fail-closes terminal delivery — and the new source-scope cases fail against the previous classifier (any retained tombstone fail-closed regardless of source).
- Post-fix: they pass — the starter returns `undefined` before queueing, `beginReplyMessageInjectionTarget` is never invoked, exactly one follow-up dispatch delivers the inbound, and unrelated tombstones no longer block a safe steer.

## Evidence

All evidence below is from this PR's branch run on the same in-repo harnesses CI uses; account/channel identifiers are omitted (redacted).

**Red → green (P1 tombstone scope).** Against the pre-fix classifier (production files stashed, tests kept), the two new receipt source-scope cases fail exactly as predicted:

```text
 FAIL  restart-recovery-receipt.test.ts > ... > is not fail-closed for a claimless entry whose tombstone belongs to a different source turn
 FAIL  restart-recovery-receipt.test.ts > ... > is not fail-closed for a claimless entry with historical tombstones when the active source is unknown
 Tests  10 failed | 9 passed (19)
```

(the other 8 failures are the Windows teardown noise described below). With the fix restored, the same file reports `Tests 8 failed | 11 passed (19)` — the 8 remaining failures are the pre-existing Windows `EPERM` teardown noise, and all 11 assertions pass, including both new source-scope cases.

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

With the front fence, the whole file is green (10/10 including the two new source-scope cases):

```text
 ✓ createChatSendMessageInjectionStarter admission fence > rejects the injection before queueing when the latest persisted entry fail-closes terminal delivery
 ✓ createChatSendMessageInjectionStarter admission fence > rejects before queueing when the captured entry itself fail-closes terminal delivery
 ✓ createChatSendMessageInjectionStarter admission fence > follows the latest persisted entry over the stale captured snapshot
 ✓ createChatSendMessageInjectionStarter admission fence > falls back to the captured entry when the latest reload fails
 ✓ createChatSendMessageInjectionStarter admission fence > queues the steer when the latest persisted entry is startable
 ✓ createChatSendMessageInjectionStarter admission fence > queues the steer when the latest persisted entry holds only an unrelated historical tombstone
 ✓ createChatSendMessageInjectionStarter admission fence > rejects before queueing when the latest persisted entry tombstones the active source turn
 ✓ gateway steer contract after the injection-start fence > routes a fail-closed inbound to follow-up dispatch exactly once, with no steer enqueued
 ✓ finalizeAcceptedChatSendMessageInjection > audits a confirmed steer as completed active_run_injected
 ✓ finalizeAcceptedChatSendMessageInjection > audits an unconfirmed-transcript steer abort as skipped, not completed
 Test Files  1 passed (1) — Tests 10 passed (10)
```

**Mock-gateway verdict (fail-closed → exactly one visible follow-up reply, zero steer enqueues).** The gateway contract case drives the real starter closure through the mock gateway: a Telegram-session inbound whose latest persisted entry holds a `terminal-pending` receipt is rejected at the injection-start boundary — `beginReplyMessageInjectionTarget` (the synchronous `queueMessage` boundary) is **not** called, so no steer is ever enqueued — and the follow-up dispatch path is taken exactly once, producing one visible reply instead of a steer plus a second dispatch. The runner-side e2e verdict is unchanged: for every fail-closed active entry state the inbound is not steered into the live run (`queueEmbeddedAgentMessageMock` / `runEmbeddedAgentMock` not called) and `enqueueFollowupRun` is called once with `runState.admission === {status: "accepted", mode: "followup"}`; plus the new unrelated-tombstone steer-acceptance case.

**Static gates.** `oxfmt --check` clean and oxlint clean on all changed files; `pnpm tsgo:core` passes.

**Windows teardown noise (environment, not this PR).** `restart-recovery-receipt.test.ts` reports 8 failures on this host; all 8 are `EPERM, Permission denied` on `%TEMP%\restart-receipt-*` temp-dir cleanup with zero assertion failures. Verified identical on the untouched pre-fix head (`git stash` → same 8 EPERM), matching the same noise class documented for the previous revision; CI runs Linux.

## Round-7 follow-up: isolated-gateway real-transport proof

The round-6 verdict asked for **isolated-gateway / real-transport** evidence — a real `chat.send` RPC over a real loopback WebSocket against a real persisted session entry, showing the gateway-to-transport path producing the after-fix response. The previous real-dispatch test drove the starter closure directly through a recording runner, which ClawSweeper flagged as mock-only.

The new test exercises the same machinery end to end through a real loopback Gateway (`installConnectedControlUiServerSuite`):

- a real authenticated WebSocket client (no live credentials, no live channel);
- the real `chat.send` RPC handler driving the real admission fence;
- a real persisted session entry carrying a terminal tombstone for the active source turn (real session store + real receipt classifier);
- the real `replyRunRegistry` recording the active source-turn identity;
- the real `beginReplyMessageInjectionTarget` (spied only to count enqueue calls) — the only mocked boundary is `dispatchInboundMessage` (the gateway-to-pipeline seam), which the live transport would normally reach.

The file is `src/gateway/server-methods/chat-send-message-injection.isolated-gateway.test.ts`. It has three cases:

1. **After-fix (terminal tombstone on the active source).** Drive a real `chat.send` RPC for a steer against a session whose latest persisted entry tombstones the active source turn. Wire-level assertions: the gateway admits the inbound (`{ok: true, payload: {status: "started", runId}}`), `beginReplyMessageInjectionTarget` is **not** called (no steer is ever enqueued), and the follow-up dispatch path is taken exactly once, carrying the inbound body and the run id the client used. This is the wire shape a Telegram/WhatsApp dashboard client would observe.
2. **Positive control (unrelated historical tombstone).** Same harness, but the tombstone belongs to an unrelated earlier source turn. The fence scopes classification to the active source, so the steer is enqueued (`beginReplyMessageInjectionTarget` is called) and the follow-up dispatch boundary is not reached. Locks in that the after-fix behavior is gated on source identity, not on the mere presence of any tombstone.
3. **Before-fix regression control (classifier weakened).** The classifier is stubbed to never fail-close (the pre-fix behavior). The steer is enqueued and no follow-up dispatch happens — exactly the silent-loss race the PR closes.

Run on this branch (`702e82d21f2` + round-7 commit):

```text
 ✓ isolated gateway: rejects steer for active-source terminal tombstone, dispatches exactly one follow-up, observes one after-fix reply over WS
 ✓ isolated gateway: still steers when the tombstone belongs to an unrelated prior source turn
 ✓ isolated gateway (before-fix control): with the classifier weakened, the steer is enqueued and follow-up dispatch is skipped

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  26.62s
```

The trace shape for case 1 (the round-6 ask) is, at the wire boundary:

```text
  chat.send → {ok: true, payload: {status: "started", runId: "idem-iso-gw-<uuid>"}}
  beginReplyMessageInjectionTarget: not called
  dispatchInboundMessage: called 1×
    ctx.Body = "round-7 isolated-gateway inbound"
    replyOptions.runId = "idem-iso-gw-<uuid>"  (matches the client-supplied idempotency key)
  reply dispatcher emits exactly one final reply via sendFinalReply("after-fix follow-up reply")
```

No live channel or model-provider credentials are involved — the gateway is a real loopback instance with a real authenticated WS client, the session store is a real temp-dir SQLite-backed session entry, and the only mocked seam is the gateway-to-pipeline dispatch boundary that the live transport would normally reach. A maintainer with a live Telegram/WhatsApp deployment can confirm the same wire shape end-to-end against a real channel inbound.

## Notes / exclusions

- The change is entirely OpenClaw-side; no Codex internals are asserted or modified.
- The runner-side fence (`agent-runner-run.ts`) is intentionally left as the authoritative safety net for the residual window between the gateway fence and the runtime's own synchronous admission check.

Closes #128971
