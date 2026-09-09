Addressed the round-5 ClawSweeper review (verdict on head `0d3ee5553b0`). Summary of what changed and the evidence behind it:

**1. [P1] Scope tombstone checks to the active source turn — fixed.**

The fail-closed classifier now takes the active source-turn identity and scopes the terminal-tombstone condition to that exact source:

- `isRestartRecoveryTerminalDeliveryFailClosed(entry, sessionId, sourceTurnId)` replaces the any-tombstone check (`hasAnyRestartRecoveryTerminalRun`) with the exact-source check (`hasRestartRecoveryTerminalRun(entry, sourceTurnId)`), so a retained tombstone only fail-closes the fence when it belongs to the target active source turn. The send path's `already-delivered`/`not-applicable` resolution is shared, so the fence and the send owner cannot drift.
- Both admission paths now carry source identity: the owning runner records the active source-turn id on the reply-run registry when it admits its delivery claim (`replyRunRegistry.bindSourceTurnId`), and the gateway's injection target carries it (`target.sourceTurnId`) with the entry's claim source as fallback. The runner-side fence uses the same registry identity.
- New regression coverage (red → green): unrelated-tombstone acceptance and same-source rejection at the receipt classifier, at the gateway injection fence, and in the runner e2e steer path (see the PR body `## Evidence` section for the full transcripts).

**2. Real behavior proof (ephemeral-gateway trace) — constraint statement instead of a fabricated trace.**

A redacted ephemeral-gateway run cannot be produced on this host, and I'm stating the mechanism rather than faking one:

- No gateway deployment exists here (`~/.openclaw` has no gateway config), no Telegram/WhatsApp bot credentials, no live LLM provider credentials; the in-repo qa-lab live lane (`startQaLiveLaneGateway`) requires real `OPENCLAW_QA_TELEGRAM_*` driver/SUT bot tokens plus live model credentials to drive a real channel inbound and an observed reply.
- ClawSweeper's own live verification of this branch's gateway suite passed (8/8 on the reviewed head), and the deterministic admission decision is the same code path the unit suites lock: the front fence rejects before `beginReplyMessageInjectionTarget` (the synchronous `queueMessage` boundary) is ever called, so a fail-closed inbound is enqueued zero times as a steer and dispatched exactly once as a follow-up.

**3. Merge-risk items 3–5** are the same P1 and proof items above. Item 6 (P2) is covered by the same regression set.

**Test results on this host** (branch head `4691a828fcf`):

- `node scripts/run-vitest.mjs src/gateway/server-methods/chat-send-message-injection.test.ts` — **10/10 passed** (includes the two new source-scope cases).
- `node scripts/run-vitest.mjs src/config/sessions/restart-recovery-receipt.test.ts` — **11 passed | 8 failed**, where all 8 failures are the pre-existing Windows `EPERM` temp-dir teardown noise (zero assertion failures; identical on the untouched pre-fix head).
- `node scripts/run-vitest.mjs src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts` — **17 passed | 148 failed**, where all 148 failures are `EPERM`/`EBUSY` temp-dir teardown noise (0 `AssertionError`s, same noise class as the prior revision's baseline). All 8 steering/receipt cases pass, including the new **"steers while the retained terminal-source tombstone belongs to an unrelated prior source turn"** and the existing same-source tombstone fail-closed case.
- `oxfmt --check` and `oxlint` clean on all changed files; `pnpm tsgo:core` passes.

The PR body has been updated with the P1 fix description, the red → green evidence, and the trace constraint statement. Please re-review when convenient — @clawsweeper re-review.
