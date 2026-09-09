Addressed the round-7 ClawSweeper review (verdict on head `702e82d21f2`). Both open items are closed at head `cdb4850fa40` (commits `e8f3288b38d` + `cdb4850fa40` on top of the round-7 proof commit `0cb6f19406a`).

**1. [P2] Initialize retained reply-registry state — fixed with retained-singleton coverage.**

- `src/auto-reply/reply/reply-run-registry.state.ts` now backfills `replyRunState.sourceTurnByKey ??= new Map();` directly beside the existing `followupAdmissionBarriersByKey` / `successorAdmissionBarriersByKey` backfills, matching the established upgrade pattern.
- New regression: `src/auto-reply/reply/reply-run-registry.retained-singleton.test.ts` plants a pre-change registry instance (every map the old module version knew, no `sourceTurnByKey`) on `globalThis`, reloads the module graph, and asserts `bindSourceTurnId` / `getSourceTurnId` work through the retained object.
- Red → green, same host and harness: before the backfill both cases fail with `TypeError: Cannot read properties of undefined (reading 'set')` at `reply-run-registry.registry.ts:122` (`2 failed (2)`); with the one-line backfill the file passes `2/2`.

**2. Real behavior proof — production chat-send handler path to one observable reply.**

The isolated-gateway proof (`src/gateway/server-methods/chat-send-message-injection.isolated-gateway.test.ts`) now carries the full chain the verdict asked for:

- a real `chat.send` RPC over a real loopback Gateway WebSocket (production `handleChatSend` path, not the admission starter called directly) against a real persisted fail-closed session entry;
- zero steer enqueues: `beginReplyMessageInjectionTarget` (spied on the real registry) is **not** called;
- one follow-up dispatch: the projected inbound dispatch boundary is reached exactly once, carrying the inbound body and the client-supplied run id;
- one observable reply: the rejected inbound is routed through the **real** follow-up queue machinery (`enqueueFollowupRun` + `scheduleFollowupDrain`, both real implementations) into a recording runner (the transport stand-in). The proof asserts the enqueue was accepted with depth 1, the drain dispatched exactly once, and the captured outbound reply carries the inbound text — the reply is drained by the real queue, not authored by the seam mock.

Honest constraint, unchanged: the mocked boundary is the gateway-to-pipeline seam (`dispatchInboundMessage`), the last hop before the live channel transport. This host has no gateway deployment, channel credentials, or live model-provider credentials, so a full live-transport trace is not producible from this fork. The wire shape (real WS client, real session store, real classifier, real registry, real queue) is the strongest evidence this fork can generate, and the updated PR body documents the redacted trace.

**Suite state at `cdb4850fa40`:** retained-singleton 2/2; reply-run-registry 87/87; chat-send-message-injection + real-dispatch 13/13; isolated-gateway 3/3; restart-recovery-receipt 11 passed + 8 EPERM teardown noise (pre-existing Windows host issue, CI runs Linux). `oxfmt --check` and oxlint clean on all changed files.
