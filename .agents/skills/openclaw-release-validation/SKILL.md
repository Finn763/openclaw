---
name: openclaw-release-validation
description: Safely copy an existing gateway, test the latest OpenClaw main commit, and guide human release-campaign feedback with one Markdown worksheet.
user-invocable: true
disable-model-invocation: true
---

# OpenClaw Release Validation

Help a human validate the latest main commit against a copy of a real gateway. Automate only
fixture setup and reporting. Let the human drive OpenClaw and judge quality.

For a ready gateway, use one editable Markdown worksheet as the entire run
record. A blocked upgrade has no worksheet or surface-testing phase; its final
report draft is the only local record. Do not create `run.json`, mission state,
receipts, or other tracking files.

## Start the run

At the start of every **Validate release** run, give a concise introduction:
this skill creates an isolated copy of a gateway, upgrades that copy to an
immutable build of the latest `origin/main`, reports upgrade problems, then
helps the tester manually check it and submit one consolidated feedback comment
to the current release's shared campaign issue. The source gateway is not modified.

Use the agent's available native checklist or plan tool to show progress and
check items off as they complete. Start with this visible checklist:

1. Confirm the release campaign and main test target
2. Choose a gateway to copy
3. Copy, upgrade, and verify readiness
4. Optionally capture local diagnostics
5. Create the testing worksheet
6. Test surfaces and record feedback
7. Draft, review, and publish feedback

For **Initialize campaign**, instead explain that the run creates the shared
issue and worksheet for a release, then ends; use a corresponding three-item
checklist: identify release, create or reuse campaign, close older campaigns.

## Workflows

Choose the workflow from the request:

- **Initialize campaign** is the asynchronous release-process path. Create or
  reuse the canonical issue for the exact campaign release, close older open campaign
  issues, print the current issue URL, and stop.
- **Validate release** is the default human-testing path. Join the existing
  campaign issue, copy a gateway, build the latest immutable `origin/main`
  target through OCM, then guide testing. This workflow never creates or
  rewrites the canonical issue.

Before the upgrade reaches a terminal ready or blocked result, keep tester-facing
output to the campaign issue, campaign release identity, gateway choice, and upgrade
progress or errors. The worksheet, priority surfaces, testing instructions, and
`finish validation` phrase are disclosed only after that gate.

## 1. Campaign release and shared issue

When the request supplies an issue URL or number, resolve it directly with
`gh issue view`. Accept it only when it is open and its body contains the exact
`<!-- openclaw-release-validation:<tag> -->` marker. Treat that tag as the
**campaign release**, then fetch only that exact GitHub release to record its
commit. This direct verification is authoritative: do not list releases or
search issues first.

When no issue is supplied, use an explicit release when supplied. Otherwise run
`gh api 'repos/openclaw/openclaw/releases?per_page=100'` once, then select the
newest published tag matching `vYYYY.M.D-beta.N` locally. Do not paginate
release history. If that bounded response has no matching release, ask for an
explicit version rather than making a slow unbounded request. Record the selected
version and commit as the **campaign release**. It identifies the shared issue
and worksheet; it is not the runtime this validation run tests.

Then run exactly one bounded lookup:

```sh
gh api 'repos/openclaw/openclaw/issues?state=open&labels=release-validation&per_page=2'
```

Ignore pull requests in the response. Require exactly one labeled issue and
require its hidden marker to equal the selected campaign-release tag. The label
is the fast discovery index; the exact marker remains the identity check. If no
labeled issue exists, tell the tester that campaign initialization has not
completed and stop. If more than one is labeled or the marker does not match,
stop and show the conflicting issue URLs. Never fall back to an unbounded
repository issue scan.

Whenever the workflow reaches its issue announcement, use this exact shape with
one raw URL and no commentary about discovery or campaign counts:

```text
Issue: https://github.com/openclaw/openclaw/issues/<number>
```

In **Validate release**, fail with `Release validation has not been initialized
for <tag>.` when the issue is absent. When it exists, announce it once in the
format above, then read its body and use the worksheet between
`<!-- validation-worksheet:start -->` and
`<!-- validation-worksheet:end -->`. Keep its release priorities and template
unchanged. Those exact bytes are the canonical campaign template for this run.
After announcing the issue, resolve the test target separately and immediately
show: `Test target: origin/main at <full SHA>`. This immutable SHA is the
runtime that this run will build and test; it never changes the release campaign
identity or its release-note priorities.

In **Initialize campaign**, first ensure the repository has a
`release-validation` label. Check for the exact label with
`gh label list --search release-validation --json name --jq
'any(.[]; .name == "release-validation")'`; create it only when that exact-name
check returns `false` with `gh label create release-validation --color 0E8A16 --description
"OpenClaw release-validation campaign"`. Do not use `--force` or alter an
existing label. Apply `release-validation` with `gh issue edit <number>
--add-label release-validation` to the canonical issue whether it is reused or
newly created, then verify the label through `gh issue view <number> --json
labels`. This makes active campaigns discoverable with `gh issue list --state
open --label release-validation` while the exact hidden marker remains the
canonical matching rule.

Reuse the current issue's body unchanged when it already exists. When it does
not exist, generate it:

1. Read the GitHub release notes for the exact tag. If they are empty or
   incomplete, also read that tag's section of `CHANGELOG.md`.
2. Fetch the live scorecard Markdown from
   `https://docs.openclaw.ai/maturity/scorecard.md`. From its **All surfaces**
   table, extract each unique surface's display name, taxonomy link, M-level,
   and maturity label. Also extract the score bands. Treat this live response as
   the complete catalog; do not use a cached or hardcoded surface list. Resolve
   relative taxonomy links against `https://docs.openclaw.ai` before publishing.
   Stop before issue creation when the scorecard is unavailable or cannot be
   parsed.
3. Read the complete release notes and group every user-visible or
   upgrade-sensitive item under one or more live scorecard surfaces. Use linked
   PR or commit metadata privately when it helps estimate change size, but never
   publish cherry-picked examples.
4. Rank exactly five priority surfaces using all of: change count and breadth,
   change size and complexity, upgrade sensitivity, scope of user impact, and
   maturity expectations. A touched Stable or Clawesome surface carries more
   regression risk than an equally changed early-stage surface because users
   rely on its stronger quality promise. Keep the ranking qualitative; do not
   expose a fake-precision score.
5. Generate one section for every live scorecard surface. Put the five selected
   surfaces under **Priority surfaces to test** and all remaining surfaces under
   **Other surfaces to test**. Format every section exactly like this:

   ```md
   ### [surface](taxonomy-url)

   | **Maturity score**      | <maturity-label>      |
   | ----------------------- | --------------------- |
   | **What changed**        | <release-theme>       |
   | **Recommended testing** | <exercise-or-em-dash> |
   | **Testing notes**       |                       |
   ```

   Keep the **Testing notes** value cell truly empty: add no placeholder text or
   hidden comment.
   Use `No notable changes in this release.` and an em dash in the last two
   table rows when no release item is relevant. Escape table pipes and keep each
   cell concise. Every priority surface must have a real recommended exercise.

   Make every **Recommended testing** cell a bounded operator workflow: name the
   exact action, the observable pass condition, and a runnable OCM-scoped command
   or concrete URL when the surface has one. Use `<br>` inside a cell when a
   command and pass condition need separation. Use the literal `{{TEST_ENV}}`
   in generated OCM commands: for example, `ocm @{{TEST_ENV}} -- onboard`,
   `ocm @{{TEST_ENV}} -- tui`, and `ocm @{{TEST_ENV}} -- channels status
--probe`. The validator replaces this token with the actual disposable
   environment name only in each tester's local worksheet. Avoid broad prompts
   that bundle unrelated features or say only to "use," "exercise," or "verify"
   a surface.

   For each **What changed**, synthesize the dominant themes across the
   surface's complete group instead of listing a few fixes. Do not include
   issue, PR, commit, or workflow examples; a handful of links misrepresents the
   full release surface. Each **Recommended testing** is one concise human-driven
   exercise.

6. Resolve the campaign creator's GitHub login with `gh api user`; ask for a
   login only when authentication cannot identify it. Enumerate every PR authored
   by that login whose merge commit is included between the previous release tag
   and the campaign release tag. Add the complete linked list under **Your changes in
   this release**, or `- None in this release.` when empty. This explicit author
   list is separate from surface summaries and may contain PR links.
7. Make a working copy of the worksheet asset and fill it with the exact
   campaign-release identity, release-notes URL, live scorecard and taxonomy URLs,
   score-band guidance, and generated surface sections. The issue callout must
   say that its catalog and labels come from the live maturity taxonomy and that
   priority reflects release change volume, size, impact, upgrade risk, and
   maturity expectations. Remove the campaign-creator comment and ensure no
   template placeholder remains except `{{TEST_ENV}}` inside OCM commands.
8. Create the issue with the stable marker, a short participation note, the
   `release-validation` label, and the completed worksheet verbatim between the
   worksheet markers. Read it back and require the marker contents to equal the
   rendered worksheet before treating campaign initialization as complete.
   Re-query open issues for the marker after creation and fail on duplicates.

After the current issue exists, find open campaign issues whose marker names a
release published before the current campaign release. Comment on each with the current
issue URL, then close it as completed. Never close the current issue or a campaign
for a later release. Re-query and require the current campaign release to be the only
open campaign. Announce its URL once in the exact format above and end the
initializer workflow without waiting for testing.

Only **Initialize campaign** performs release-note analysis or generates the
canonical template. Validation runs consume the issue body without rewriting
it, but replace **Your changes in this release** in their private worksheet with
the current tester's complete authored-PR list for the same tag range. The
bundled worksheet asset is initializer-only; a validation run never reads it.

## 2. Choose and copy a real gateway

First run `ocm --version`. If OCM is unavailable, pause before discovering or
copying any gateway and say:

```text
OCM is required to create an isolated, disposable copy of your gateway for
this release test and is not installed.

Would you like me to install OCM now? This installs the OpenClaw Manager CLI
on this machine. Reply exactly `install OCM` to approve, or install it yourself
and reply `OCM installed`.
```

Install OCM only after the tester explicitly replies `install OCM`. Use the
official release installer, then verify `ocm --version` before continuing:

```sh
curl -fsSL https://github.com/openclaw/ocm/releases/latest/download/install.sh | bash
ocm --version
```

If the binary was installed to `~/.local/bin` but that directory is not on the
current PATH, use `~/.local/bin/ocm` for this run and tell the tester to add it
to their PATH for future shells. If installation or verification fails, report
the exact error and remain paused. Do not replace OCM with a manual state copy.

Discover once with `ocm env list --json`. In parallel, inspect the plain home
with `ocm adopt inspect ~/.openclaw --json` and obtain its version and service
state with `openclaw --version` and `openclaw gateway status --json --no-probe`.
Read only the version and running/stopped state from the latter; do not expose
its command, paths, configuration, or environment. If the plain home's resolved
path is an OCM environment's `stateDir`, show it once as that environment's
personal-state alias. Otherwise show `Personal ~/.openclaw` with its known
version and running state. Keep the overview shallow: do not inspect plugins
or other gateway internals. Ask which gateway the tester wants to copy. Never
silently select or modify the personal gateway.

After selection, inspect only that gateway and record its version and commit.
Preview the disposable target, then import its `.openclaw` state with OCM so
sessions and other real user state are preserved in the fixture:

```sh
ocm adopt plan --name <test-env> <selected-state-dir> --json
ocm adopt import --name <test-env> <selected-state-dir> --json
```

Use the `stateDir` returned by `ocm env list --json` for an OCM environment and
`~/.openclaw` for the plain gateway. Let OCM create the stopped, disposable
environment and assign a non-conflicting port; do not make an additional staged
copy. OCM copies a configured repo-backed or symlinked workspace into the
disposable environment and rewrites the fixture config to that copy; it never
changes the source repository or workspace. The returned environment name is
the test environment; use that actual name in every tester-facing command
rather than the `<test-env>` placeholder. If OCM cannot isolate a config include
or source path, pause and report that setup blocker conversationally—never make
a manual state copy or put it in the campaign worksheet. Keep the source
unchanged. Before activating copied channel credentials, stop the current
credential owner and restore it when validation ends. For an OCM source, use
`ocm service stop <source-env>`; for the plain source, use `openclaw gateway
stop`. There is no `ocm stop` command.

## 3. Build the latest main target, upgrade, and report errors

For every **Validate release** run, resolve a fresh immutable main target after
the campaign issue is known and before building the runtime. Never build from
the caller's active checkout. Resolve exactly one SHA, create a run-owned
isolated checkout at that SHA, and prove the checkout did not move:

```sh
main_sha="$(git ls-remote https://github.com/openclaw/openclaw.git refs/heads/main | awk 'NR == 1 { print $1 }')"
test "$(printf '%s' "$main_sha" | wc -c | tr -d ' ')" = 40
main_checkout="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-release-validation-main.XXXXXX")"
git -C "$main_checkout" init -q
git -C "$main_checkout" remote add origin https://github.com/openclaw/openclaw.git
git -C "$main_checkout" fetch --depth 1 origin "$main_sha"
git -C "$main_checkout" checkout --detach -q FETCH_HEAD
test "$(git -C "$main_checkout" rev-parse HEAD)" = "$main_sha"
```

If resolution, fetch, checkout, or SHA verification fails, report the setup
blocker conversationally and pause. Do not fall back to a moving branch, a
caller checkout, or the campaign release package.

Give the run-owned runtime a unique name containing the short main SHA and a
UTC timestamp, then build and verify that exact checkout through OCM. Use the
same named runtime for the disposable fixture:

```sh
ocm runtime build-local <run-runtime-name> --repo <main-checkout> --force
ocm runtime verify <run-runtime-name>
ocm upgrade <test-env> --runtime <run-runtime-name> --dry-run --json
ocm upgrade <test-env> --runtime <run-runtime-name> --json
ocm service start <test-env>
```

Stop any current owner of copied channel credentials immediately before the
`ocm service start` command. Record `origin/main` and the full `main_sha` in
the private worksheet as the **Test target** and **Test commit**. The campaign
campaign release tag and commit remain the worksheet's **Release** and **Commit** fields.

Verify `ocm service status <test-env>`, `ocm @<test-env> -- --version`, and
`ocm logs <test-env> --tail 100`. OCM's successful managed upgrade already
requires HTTP health and gateway reachability.

Report every error to the tester immediately, including errors recovered by a
retry. Retain test-target OpenClaw behavior caused by the upgrade as an
eligible **Upgrade finding** for the final report; add it to the worksheet only
when readiness is verified. Keep OCM, copying, local tooling, setup, and cleanup
problems in the conversation only; they never enter the worksheet or GitHub
comment.

Complete this step only when test-target readiness is either verified or blocked
with a concrete terminal finding. Do not continue to testing while the upgrade
or gateway readiness is unresolved.

If readiness is **blocked**, this is a terminal upgrade-validation result: mark
the optional diagnostics, worksheet, and surface-testing checklist items as
skipped. Do not create, open, mention, or ask the tester to use a worksheet;
there is no running gateway to test. State plainly:

```text
Upgrade blocked — the copied gateway never started, so manual surface testing cannot begin.
Reply exactly `finish validation` to prepare a reviewable report of this upgrade finding, or tell me any final feedback to include.
```

Then wait for final feedback or `finish validation`.

## 4. Optional local diagnostics capture

Offer this step only after the test target is ready. It is opt-in and only
applies to the disposable test environment. Say:

```text
Optional local diagnostics can capture traces, metrics, and logs from this
test gateway. It installs OpenClaw's diagnostics-otel plugin only in the
disposable copy and sends OTLP only to a collector on this machine. Content
capture stays off. Nothing is sent to a hosted endpoint, and you will review
the exact release-report draft before any GitHub comment is posted.

Reply exactly `enable local diagnostics` to enable it, or `skip local diagnostics` to continue without it.
```

Do nothing until the tester chooses. If they skip it, record no diagnostic
state and continue to the worksheet. If Docker is unavailable or its daemon is
not running, state that local diagnostics are unavailable and continue without
it. Do not install Docker, use a hosted collector, or fall back to a remote
endpoint.

When the tester replies `enable local diagnostics`:

1. Create a `telemetry/` directory beside the private local worksheet artifact
   directory. It is private run data, not worksheet content and never GitHub
   content. Create this collector configuration as `otel-collector.yaml` in
   that directory:

   ```yaml
   receivers:
     otlp:
       protocols:
         http:
           endpoint: 0.0.0.0:4318
   processors:
     batch:
       timeout: 1s
       send_batch_size: 256
   exporters:
     file/traces:
       path: /telemetry/traces.jsonl
       rotation:
         max_megabytes: 8
         max_backups: 1
     file/metrics:
       path: /telemetry/metrics.jsonl
       rotation:
         max_megabytes: 8
         max_backups: 1
     file/logs:
       path: /telemetry/logs.jsonl
       rotation:
         max_megabytes: 8
         max_backups: 1
   service:
     telemetry:
       logs:
         level: warn
     pipelines:
       traces:
         receivers: [otlp]
         processors: [batch]
         exporters: [file/traces]
       metrics:
         receivers: [otlp]
         processors: [batch]
         exporters: [file/metrics]
       logs:
         receivers: [otlp]
         processors: [batch]
         exporters: [file/logs]
   ```

2. Start one run-owned collector with the maintained, pinned
   `otel/opentelemetry-collector-contrib:0.104.0` image. Mount the configuration
   read-only and the private telemetry directory read-write. Use
   `-p 127.0.0.1::4318` so Docker chooses an unused host port and publishes it
   only on loopback. Use `--read-only`, `--cap-drop=ALL`,
   `--security-opt no-new-privileges`, `--pids-limit 128`, and a small `/tmp`
   tmpfs. Inspect the running container and resolve its assigned host port with
   `docker port <collector-name> 4318/tcp`. Require a `127.0.0.1:<port>`
   binding; stop the collector and skip capture if anything else is exposed.
   The collector configuration has file exporters only: never add an exporter,
   endpoint, header, or credential supplied by the source gateway.
3. Install the current official ClawHub package into the fixture only:
   `ocm @<test-env> -- plugins install clawhub:@openclaw/diagnostics-otel`.
   The test target verifies the plugin API compatibility during installation.
   Require a successful `plugins inspect diagnostics-otel --json` that reports
   the official ClawHub source and an accepted compatible version. If that
   compatibility check fails, stop the collector, report capture unavailable,
   and continue without diagnostics. Do not force the install, use a local code
   checkout, or select an unverified package version. Enable it with
   `ocm @<test-env> -- plugins enable diagnostics-otel`.
4. Replace only the fixture's `diagnostics.otel` object with this exact
   JSON value using `ocm @<test-env> -- config set diagnostics.otel <json>
   --strict-json`; do not merge so old signal-specific or remote endpoints
   cannot survive:

   ```json
   {
     "enabled": true,
     "endpoint": "http://127.0.0.1:<assigned-port>",
     "protocol": "http/protobuf",
     "serviceName": "openclaw-release-validation",
     "traces": true,
     "metrics": true,
     "logs": true,
     "logsExporter": "otlp",
     "sampleRate": 1,
     "flushIntervalMs": 1000,
     "captureContent": false
   }
   ```

   Also set `diagnostics.enabled` to `true`, validate the fixture config, then
   restart it through `ocm service restart <test-env>`. Verify the plugin is
   enabled, the collector remains loopback-only, and the fixture is healthy.
   On any failure, disable the plugin, set `diagnostics.otel.enabled` to
   `false`, stop the collector, and continue the release test without local
   diagnostics. Keep these setup failures out of the worksheet and GitHub.

Keep the collector running only while the fixture is under test. It captures
traces, metrics, and logs locally with bounded file rotation. The source
gateway, personal OpenClaw home, and shared GitHub issue remain untouched.

## 5. Create and reveal the worksheet (ready runs only)

Only when readiness is verified, copy the canonical worksheet between the
shared issue's markers byte-for-byte to
`.artifacts/openclaw-release-validation/<tag>-<timestamp>.md`. Fill in the
source, shared issue URL, test target and commit, terminal upgrade result, and
eligible upgrade findings without changing the campaign priorities. Refresh
**Your changes in this release** for the current tester.

Preserve every other heading, table, callout, surface order, maturity score,
release theme, and recommended test exactly as copied. The only validation-run
edits are the source fields, **Test target**, **Test commit**, **Your changes in
this release**, **Upgrade findings**, **Upgrade result**, non-empty **Testing
notes** cells, and **Final feedback**, plus replacing every `{{TEST_ENV}}` token (and legacy
`<test-env>` token) in local command guidance with the actual disposable
environment name. If an older shared campaign template lacks **Test target** or
**Test commit**, add those two fields directly under its campaign-release header
in the private copy only. Never regenerate, reformat, or substitute the campaign
template, and never write this local substitution back to GitHub.

Resolve the worksheet's absolute path and open it yourself with the appropriate
platform command: `open '<absolute-path>'` on macOS, `xdg-open
'<absolute-path>'` on Linux, or `start "" "<absolute-path>"` on Windows. If
opening fails, report the error and continue. After opening it, print only:

```text
Testing worksheet: /absolute/path/to/worksheet.md
```

Then give this compact orientation, using the actual worksheet contents:

- **What it is:** their private run record and the source for the final
  release-feedback comment; it is not another task to complete.
- **Priority and scorecard:** the five priority surfaces are the most important
  release checks; their maturity score and label come from the live OpenClaw
  maturity scorecard, where higher maturity carries a stronger regression
  expectation. The remaining surfaces are optional coverage.
- **How to use each surface:** **What changed** summarizes the release theme,
  and **Recommended testing** gives a concrete manual exercise and pass
  condition.
- **How to leave feedback:** as they test, they should simply tell the agent
  their notes and name the surface (for example, `Models: switching persisted
after restart`). The agent adds those notes to that surface's **Testing
  notes** cell. They do not need to edit the file themselves.

Finish with the exit instruction: **You can stop after any amount of testing;
you do not need to cover every surface. When you are ready to wrap up, reply
exactly `finish validation`.** That tells the agent to collect any missing
promotion feedback, stop the disposable fixture, restore any source gateway it
stopped, and prepare a reviewable consolidated release-feedback draft. Then ask
which surface they want to test first.

This worksheet is the only checklist and note store. Readiness is verified at
this point, so continue to human-driven testing.

## 6. Human-driven testing

Ask: **What do you want to test first?** Recommend starting with a release
priority, but let the tester choose one surface at a time in any order. After
each item, add their notes to that surface's **Testing notes** table cell, then
ask what they want to test next.

The tester drives interactive surfaces such as the TUI, Control UI, onboarding,
channels, pairing, and approvals. Provide the command or URL and explain what
to look for, then wait for their result. Take control only when explicitly
asked. Do not turn the checklist into an automated scenario runner.

A surface counts as tested only when tester-authored text appears in its
**Testing notes** row. The **Maturity score**, **What changed**, and
**Recommended testing** rows are campaign guidance, never test evidence. An
empty Testing notes value means untouched. Escape table pipes and use `<br>`
between multiple notes. Add test-target problems found during surface testing to
that cell.

## 7. Draft, review, and publish

When the tester says `finish validation`:

1. If readiness is verified, read the worksheet and ask only for a missing
   promotion vote or final feedback. If readiness is blocked, do not create or
   read a worksheet: use the recorded campaign, source, test-target, terminal
   upgrade result, and eligible upgrade findings, then ask only for missing
   promotion feedback.
2. Collect a small **Test environment** profile for the visible report draft.
   This is diagnostic context, not a finding and never enters the hidden
   structured payload. Include only the OS name and version, CPU architecture,
   logical CPU count, memory rounded to the nearest whole GiB, and OCM version.
   Read those individual values with narrow native commands; omit an unavailable
   value rather than collecting a broader system profile. Never read or report
   the hostname, username, device model, serial number, UUID, network addresses,
   disk layout, installed software, environment, or a raw command output.
3. If local diagnostics are active, stop the copied gateway first so its OTLP
   exporters flush, wait briefly for the collector's one-second batch flush,
   then stop the run-owned collector. Read only its three private telemetry
   files. Select at most three short snippets that directly corroborate a
   worksheet note, final feedback, or an eligible upgrade finding. Telemetry
   can strengthen an existing finding but cannot create a new one.
4. Treat telemetry as unsafe source material. Never copy raw JSON, log bodies,
   attributes, resource values, timestamps, trace/span IDs, hostnames, file
   paths, session identifiers, request identifiers, prompts, responses, tool
   inputs, tool outputs, or credentials. A permitted snippet contains only an
   aggregate signal count, a known OpenClaw operation name, a span status, or a
   low-cardinality error category. If relevance or redaction is uncertain, omit
   the telemetry. Label included prose **Local telemetry evidence** and keep it
   immediately below the finding it corroborates. Do not put telemetry in the
   hidden structured payload.
5. Restore any source gateway stopped for channel ownership. Ask before
   destroying the disposable environment. If it is retained, retain the
   run-owned runtime too and disable `diagnostics-otel`, set
   `diagnostics.otel.enabled` to `false`, restart the fixture through OCM, and
   remove the plugin with `ocm @<test-env> -- plugins uninstall diagnostics-otel
   --force`. If the fixture is destroyed, remove only its run-owned runtime with
   `ocm runtime remove <run-runtime-name>` after the fixture is gone. Remove the
   run-owned isolated main checkout after no build or fixture command is using
   it. Never remove a shared runtime. Remove the run-owned collector in all cases.
6. Synthesize one final release-analysis comment from the **Campaign release**
   release tag and commit, the exact **Tested main commit** full SHA, source
   version/commit, upgrade findings, tester feedback, the yes/no promotion vote,
   and only the surfaces with non-empty Testing notes cells. State clearly that
   the release identifies the feedback campaign while the runtime tested was
   `origin/main` at that SHA. Use those cells as the source of observed results;
   do not report the other table rows as evidence. For a blocked run, list no
   tested surfaces and use the recorded upgrade finding as the sole evidence.
   Start the visible comment with these two lines so the tested binary is never
   ambiguous:

   ```md
   - Campaign release: <release tag> (<campaign release commit>)
   - Tested main commit: <full SHA>

    ## Test environment

    - OS: <name and version>
    - CPU: <architecture>, <logical core count> logical cores
    - Memory: <whole GiB> GiB
    - OCM: <version>
   ```
   Omit any unavailable value; do not add substitute device facts. The profile
   is brief diagnostic context, not an upgrade finding or surface result.
7. Remove local paths, gateway names, secrets, user identifiers, raw logs, OCM
   notes, setup details, and cleanup details from the comment. Keep the
   allow-listed **Test environment** values from the preceding step.
8. Read and apply the [structured report contract](references/structured-report.md).
   Append its hidden v1 payload and validate the complete comment. Write the
   proposed comment to a private Markdown draft beside the worksheet, open it
   for the tester, and say:

   ```text
   I opened the proposed release report for review. It has not been sent.
   Reply exactly `approve report` to post this draft, or tell me what to change.
   ```

   On edits, revise and reopen the same draft. On `approve report`, re-read the
   draft, re-run the privacy, schema, and size validation, then create or update
   this GitHub user's one report comment for the release. Never post a comment
   from `finish validation` alone. Show the tester the resulting comment URL.
9. Give the tester this concise copy-ready Discord summary, populated only from
   the same release-facing worksheet evidence and final comment:

   ```md
   **Release validation — <campaign-release-tag>**
   Tested main: <full SHA>
   Tested: <surfaces with non-empty Testing notes, or "No manual surface testing completed">
   Key findings: <concise release findings, or "None reported">
   Recommendation: <yes / no>
   Details: <GitHub comment URL>
   ```

   Keep it to these six lines. Exclude source gateway details, local paths,
   OCM/setup information, cleanup, credentials, and untested surface guidance.
   This is a copy/paste handoff for the tester; do not post it automatically.

The skill collects release feedback; it does not make the go/no-go decision.
