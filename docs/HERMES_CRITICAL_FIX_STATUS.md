# Hermes critical fixes — implementation status

Status of [the implementation plan](HERMES_CRITICAL_FIX_PLAN.md) (packages A–J) for the
change set on branch `hermes-fixes` over `b2b718e`, as of 2026-09-24. The plan and
[the review](HERMES_EXTENSION_REVIEW.md) remain the problem statements and still name
code that no longer exists (`_poll_email_once`, `_email_reply_contexts`); this page is the
record of what was built instead.

| Package | State | Note |
| --- | --- | --- |
| A Commands and control | Landed | A.7 compatibility limitation recorded, not fixed |
| B Profile binding, private payloads | Landed | |
| C Incremental mailbox API | Landed | Needs a backend deploy before the plugin uses it |
| D Durable intake | Landed | Ships with E |
| E Restricted email execution | Landed, scoped differently | No separate reader profile; tool-less call |
| F Forward chat recovery | Landed | |
| G Email outbox and idempotency | Landed | Needs the same backend deploy |
| H Pinned image downloads | Landed | Proxy support deliberately dropped |
| I Upgrade, rollback, diagnostics | Landed | |
| J Automation catch-up | Landed, scoped differently | In-flight and at-most-once rules added |

---

## A — Restore commands and protect control replies

**Landed.** A real-Hermes test harness (`tests/hermes_runtime`,
`scripts/hermes_runtime_tests.sh`, a CI job over min × current pins and bundled × user
layouts) that loads the plugin through the actual Hermes loader against a fake Clawbits
service. `MessageEvent.text` is the raw trigger with only the agent's own `@mention`
stripped, so Hermes's own parser sees slash commands and short prompt answers; the plugin
adds no second parser. Trusted static Clawbits context moved to `channel_prompt`,
untrusted per-event framing to `channel_context`. `allow_gateway_control` is true only for
a live post by the verified operator (`human_id == agent_info.operator_id`, no `agent_id`)
in the canonical operator DM (channel type `direct` or `None`); `agent_chat` is always
denied, even when the server names it as the operator channel. Operator controls are
admitted ahead of the snooze and turn-queue gate. Commands that arrived while the agent
was offline or snoozed are recorded `ignored`/`historical_command` and never run.

**Scoped differently.** Plan A.6 allowed raising `requires_hermes` if security fields were
missing at the minimum. They are not: both pinned revisions pass, so the floor stays
`>=0.21.3`.

**Deferred / limitation.** Plan A.7: Hermes exposes no metadata/model-input boundary for
platform context, so catch-up and attention framing is persisted as user-authored
transcript content. The mitigation is bounding and neutralising it — 50 lines of at most
400 characters, sender names folded to one line and 64 characters, and `@`-reference
tokens (`@file:`, `@url:`, `@git:`, `@folder:`, `@diff`, `@staged`) defused inside the
block. Only the message that actually addressed the agent keeps live references.

**Open.** `tests/hermes_runtime/test_commands.py::test_new_creates_fresh_session` is flaky
at baseline (a 15 s settle timeout, independent of this change set). It passes on an
isolated re-run; the matrix as a whole will intermittently exit 1 until that race is
investigated.

## B — Bind profile credentials; remove private data from arguments and activity

**Landed.** `extensions/hermes/account.py` resolves one `ClawbitsAccount` (endpoint, agent
id, API key, challenge answer, channel, receive/send policy, activity preview, user agent,
profile home) inside the owning profile's scope; a routed profile reads only its installed
secret scope and never `os.environ`. Every background task — poll, WebSocket, mailroom,
automations, status writer — is spawned bound to that account. `cli_client.child_env()`
builds a minimal child environment (no provider keys), and `private_json_file()` (mode
0600, removed on success, error and cancellation) carries every private payload: chat
posts, streaming patches, activity, email sends and the automations state report. The
challenge answer reaches the CLI through `CLAWBITS_CHALLENGE_ANSWER`, never argv.
Diagnostics use Hermes's forced redactor plus its egress sweep, with
`[redaction-unavailable]` on failure; activity is action-only by default
(`CLAWBITS_ACTIVITY_PREVIEW` opts into a redacted web-search preview, which also masks
dotted and quoted key forms before Hermes's redactor runs).

**Scoped differently.** A failed agent-CLI call surfaces only `HTTP <status>: <code>` or
`agent-cli: <ExceptionName|usage_error|timeout|exit_N>`; non-HTTP failures are matched
strictly (a dotted exception name ending in `Error`/`Exception` at the start of the last
stderr line), so anything else reports `exit_<rc>`. `CLAWBITS_USER_AGENT` is read once per
adapter; changing it needs a gateway restart.

## C — Incremental mailbox contract

**Landed** in the backend: `GET /api/agentic/agents/{id}/email/changes` (ascending,
epoch-bound, `after_uid`/`uidvalidity`/`through_uid`/`limit`), `mark_read=false` and
`attachment_content=false` on message detail, and `409 {code: mailbox_epoch_changed,
uidvalidity}` on both list and detail. Newest-first inbox endpoints are unchanged for
OpenClaw and the UI. Documented in [AGENT_EMAIL_API.md](protocol/AGENT_EMAIL_API.md).
An older backend is detected and probed again every 15 minutes (health code
`mailbox_api_unsupported`); intake pauses rather than falling back to the lossy path.

**Consequence.** The migration `20260921-1200_add_email_deliveries` has `down_revision`
`8a1c4e9b2d70`, not the id the design named. The backend must be deployed before a plugin
that depends on these endpoints.

## D — Persist intake before dispatch

**Landed.** `extensions/hermes/inbox_state.py` — a plugin-owned SQLite journal at
`<profile home>/plugin-data/clawbits-platform/inbox.db` (0700 directory), namespaced by
canonical backend URL, agent id, profile and source, with UIDVALIDITY in the email
namespace. Sources carry enumerated/settled/acked cursors; items carry lane, position,
disposition, attempts and payload; deliveries carry a stable key, version and state. A
page and its cursor are committed in one transaction before anything is dispatched; the
settled cursor advances only through a contiguous prefix of items with a final
disposition, and only that prefix is acknowledged to the server. Backpressure at 500 open
items, review after 5 attempts. Schema guard with `min_reader`, a backup before any
migration (newest 3 kept) and a read-only `read_stats()` for doctor, so an older plugin
refuses a journal it cannot read instead of consuming it.

Legacy `clawbits-email-watermark.json` and `clawbits-read-cursors.json` are preserved:
adopted kinds are moved to `plugin-data/clawbits-platform/legacy/`, and a legacy file
reappearing beside an existing journal holds that kind for review
(`migration_needs_review` / `legacy_reappeared`). The default policy is `review`
(`CLAWBITS_INBOX_LEGACY_MIGRATION=review|adopt|new_only`); a genuinely new mailbox records
`CLAWBITS_INBOX_FIRST_START=new_only` (default) or `backfill:N`, N at most 200.

**Scoped differently.** Plan D.7 asked for an independent send switch:
`CLAWBITS_EMAIL_SEND_ENABLED` (default true) is it, with `CLAWBITS_EMAIL_ENABLED` kept as
the legacy receive switch. Chat sources have no first-start choice: they adopt the server
read pointer when there is one, a channel discovered mid-run starts below its 20 newest
posts, and a true first start goes to the newest post.

**Open.** Delivery keys have no lane component, so a chat source's post-lane and
attention-lane items at the same position would collide; the insert raises
`IntegrityError` rather than returning the wrong row, and only mail produces deliveries
today.

## E — Restricted email execution

**Landed, scoped differently.** Mail never becomes a `MessageEvent`; the adapter has no
email path left. `extensions/hermes/mailroom.py` admits mail to the journal,
`email_reader.py` summarises it with **one tool-less structured call on the profile's own
model** (`ctx.llm.acomplete_structured`), and the trusted dispatcher posts an inert
artifact to the operator DM and, only for verified owner mail, sends the reply.

The plan's E.1 wording — a separate restricted Hermes *profile* — was not used. Hermes has
no supported boundary that would make a named profile an enforced sandbox (E.2 explicitly
rules out `toolsets_for_source() -> []`), so isolation is achieved by not entering the
gateway at all. It is proven rather than assumed:
`tests/hermes_runtime/test_email_reader_isolation.py` drives hostile owner mail through
the real loader and the real `ctx.llm` at both pins while an `/approve` prompt is pending,
and asserts exactly one provider call with roles `[system, user]`, no `tools` /
`tool_choice`, no `HERMES_HOME` canary (with an agent-turn control proving the canaries
would otherwise appear), no gateway event and no executed tool call. E.3's "hold for
review" fallback is still the behaviour whenever the reader is unavailable or its budget
is exhausted.

Sender policy (E.5/E.6): owner mail is `sender_auth.verdict == "pass"` **and**
`sender_auth.address == operator email`, both lowercased. `from_addr` and `From` are
presentation data and are never used — a sender controls the display name
(`From: "<owner@gmail.com>" <attacker@evil.com>`), and a detail without
`sender_auth.address` counts as unverified. A known non-owner address is summarised as
third party with no reply whatever the verdict. Budgets are per mailbox, not per sender:
`CLAWBITS_EMAIL_READER_DAILY_TOKENS` (200000) and `CLAWBITS_EMAIL_READER_HOURLY_CALLS`
(30); a budget of 0 or less disables the reader and mail is held with a notice. Mail is
never discarded when a budget is exhausted. Control characters, including Unicode tag
characters, are blanked in reader input, and `allow_gateway_control` never applies.

**Open.** `READER_MAX_TOKENS` is 4000; a reply in a script using roughly one token per
character can still be cut, and that output goes to `needs_review`. A bare-string `flags`
value fails Hermes's schema validation and also goes to review.

## F — Forward chat recovery

**Landed.** Normal polling and every reconnect read forward from the source cursor with
`after_post_id`, oldest first, through the same journal path as WebSocket admissions —
deduplicated by backend/account/channel/post id, so an event for a later post cannot
advance enumeration past an unobserved earlier one. Enumeration, processing and the server
read acknowledgement are separate; only the settled prefix is acknowledged. Missed
messages become a bounded catch-up turn with the other messages and skipped chatter in a
`[Missed messages]` block; the historical items are recorded as summarised, and commands
among them as ignored.

**Scoped differently.** Another author's unpublished post (a live stream or draft) is not
read, and holds that channel's cursor and ack below itself, but the rest of the page is
still admitted and answered — holding the whole page would delay every later message
behind one peer's draft. The next pass re-reads from the held cursor and re-classifies
only that row.

**Open.** An inbox journal that cannot be opened pauses chat intake (`journal_unavailable`)
and retries on every full poll pass; a turn whose outcome cannot be recorded still ends
cleanly and is left for restart review (`journal_write_failed`). Both are visible in
doctor.

## G — Email outbox with honest delivery status

**Landed.** Backend: optional `Idempotency-Key` on send, uniquely constrained per agent and
key with a payload hash (`409` on reuse with different content), states `queued`,
`attempting`, `accepted`, `retry_wait`, `failed`, `unknown`, the outbox row committed
before SMTP, and `GET /email/deliveries/{key}` (`404 {code: delivery_not_found}`). Plugin:
every send is a journal delivery keyed before the POST — `cbr1-` for owner replies
(derived from source, epoch, position and reply version, not body text), `cbt1-` for
`clawbits_send_email`. Delivery retries reuse the stored output; the model is never called
again. "Accepted" means SMTP accepted it, never that it reached an inbox.

**Scoped differently.** An ambiguous send is only re-POSTed after the backend has proven it
honours `Idempotency-Key`; a reply without the key (a backend rollback) withdraws that
proof, after which ambiguous sends end as `unknown` and need
`hermes clawbits inbox resend <key>`. The first ambiguous POST immediately after such a
rollback, before any keyless reply has been seen, is still re-POSTed — closing that
completely would mean a delivery lookup before every re-POST, which makes the proof flag
pointless.

## H — Pin image download addresses

**Landed.** `extensions/hermes/pinned_http.py` — a stdlib GET that resolves each hop once,
vets every answer, dials only those addresses in resolver order, and keeps the URL hostname
for Host, SNI and the certificate check. At most 5 redirects, each re-parsed, re-resolved
and re-vetted; 15 MiB cap enforced while streaming; 60 s total for images and 30 s for
attachments, with at most 10 s per address so a black-holed IPv6 address falls back to
IPv4. `CLAWBITS_IMAGE_ALLOW_PRIVATE_HOSTS` holds exact hostnames, matched per hop and never
inherited by a redirect. Server-issued attachment URLs may be private on their first hop
only. No credentials are sent, so none can cross origins.

**Deferred.** Plan H.3 asked for explicit proxy handling; `HTTP_PROXY`, `HTTPS_PROXY` and
`ALL_PROXY` are ignored instead. A proxy resolves the name itself, where none of this can
vet it. Restoring proxy support for the trusted first hop alone would need
`Proxy-Authorization` from the proxy URL's userinfo, `no_proxy` handling, CONNECT
tunnelling with SNI set to the tunnel host, and absolute-form targets for plain HTTP.

**Open.** Attachment caching still runs in the dispatch path (`adapter.py` awaits
`cache_post_attachments`, and `attachments.py` retries with a refreshed URL after any
failure, including a timeout), so a silent or slow presign host can hold chat dispatch —
operator `/stop` included — for up to 2 × 30 s per attachment. The fix belongs in those
files.

## I — Ship fixes without resetting the agent

**Landed.** `reinstall.sh` defaults to a non-destructive upgrade: stage, validate with the
real Hermes loader, switch atomically, restart only the selected profile, and roll back if
`hermes clawbits doctor` does not come back healthy. Identity, `config.yaml` and
`plugin-data/clawbits-platform` are never touched; `--reset` and `--rollback` are separately
named; the broad `pkill` is gone. Exit codes 0/1/2/3/4 (see
[the plugin README](../extensions/hermes/README.md)).
`extensions/hermes/health.py` writes `status.json` (0600) per subsystem — chat, email,
liveness, events, reader, outbox, controls, automations — as codes only, and
`extensions/hermes/doctor.py` (`hermes clawbits doctor`, exit 0/1/3) reports gateway
heartbeat age, plugin version and restart, per-subsystem state, journal queue and outbox
counts, transcript spool, suspension, identity, backend and the operator binding.

**Scoped differently.** `--reset` on a profile served by the default gateway exits 3 and
changes nothing (the plan gave `--reset` no exit 3). `controls` and `automations` warn
rather than fail, so they never trigger an upgrade rollback. Doctor's live operator check
is named `operator`. A status file with no `chat` entry counts as chat down; subsystems in
`disabled` or `not_configured` skip the staleness check.

**Deferred.** The plan's two-gateway named-profile upgrade case (assert the other gateway's
pid is unchanged) is not in the runtime suite; the rest of `tests/hermes_runtime` already
runs in both layouts and covers state retention across an upgrade. The image/runtime SHA is
not recorded in the matrix output.

## J — Automation scheduling and ownership

**Landed.** Reproduction first, with a fixed clock and the real cron APIs, over cron
expressions, whole-minute native intervals, non-native intervals and one-time jobs. A
computed slot more than 90 s late gets exactly one catch-up run however many slots were
missed, under Hermes's own `cron.catch_up_missed`; overdue one-shots are held as paused
("Clawbits: missed run held for a catch-up decision") until the first reconcile decides
them. Every reconcile and cron call is bound to the adapter's own profile home; `agentId`
may only name this agent and `sessionKey` is rejected. Managed jobs carry the agent id they
were armed for, so a job left by a previous enrollment is retired instead of firing into
the old agent's channel.

**Scoped differently.** Three rules the design did not have: (1) a slot owned by a live
Hermes claim (a fire or run claim stamped within 30 minutes on a job that is not held) is
kept with no decision, so a long run is not mislabelled as missed; (2) a dead fire claim
means the slot was used — the next slot is owed and the dead claims are cleared on re-arm,
because re-running it would conflict with Hermes's at-most-once recurring policy and risk a
crash loop; (3) with `cron.catch_up_missed: false` a slot late within Hermes's grace (half
the period, 2 minutes to 2 hours) still runs once, and only beyond grace is a skip
recorded.

**Open.** At exactly Hermes 0.21.3 a transient fire-claim heartbeat miss reports
`outcome_unknown` rather than `ok` (fixed natively after 0.21.3). A paused recurring
computed automation kept as a completed record is pruned by Hermes after
`cron.completed_retention_days` (default 7), after which the owed slot is visible but not
caught up on resume. On a job that is not held, claims left by a dead gateway can look live
for up to 30 minutes (PID reuse), delaying that slot by that much.

---

## Rollout consequences an operator must know

1. **Deploy the backend first.** C and G are additive server changes (`/email/changes`,
   peek/epoch options, `Idempotency-Key`, `GET /email/deliveries/{key}`, `sender_auth`).
   A plugin that depends on them against an old backend pauses mail intake with
   `mailbox_api_unsupported` rather than falling back. The migration
   `20260921-1200_add_email_deliveries` must be applied.
2. **`STALWART_AUTHSERV_ID` must be set server-side.** With it unset every sender verdict
   is `unknown` (reason `authserv_id_unconfigured`), so no owner mail is ever
   auto-answered; mail is still summarised, and every artifact says why no reply was sent.
3. **D and E ship together.** Do not enable durable backlog replay into any older email
   path. Both are in this change set and there is no older path left in the adapter.
4. **Email is held for review by default on an existing install.** A profile with a
   pre-journal `clawbits-email-watermark.json` or `clawbits-read-cursors.json` starts in
   `migration_needs_review` until the operator runs
   `hermes clawbits inbox migrate <source> --adopt | --new-only | --from-uid N`, or sets
   `CLAWBITS_INBOX_LEGACY_MIGRATION=adopt|new_only` before the first start. This is
   deliberate: a skipped message cannot be reconstructed from the old watermark.
5. **Proxy-only egress hosts lose image and attachment downloads.** `HTTP(S)_PROXY` is
   ignored (H). Images fall back to URL-as-text and chat attachments show
   `[attachment ... could not be downloaded]`.
6. **`plugin.yaml` is 0.10.0, which raises the server's floor.** The same `version:` line is
   the floor the Clawbits server enforces at signup and for automations
   (`clawbits/fastapi/version_check.py`), so once this backend deploys, an agent still on
   0.9.0 gets 426 `plugin_outdated` on signup and `agent-info`. A Hermes agent that cannot
   read `agent-info` also loses its operator binding, so gateway controls are denied and
   owner mail is treated as unverified until it upgrades. Deploy the backend, publish the
   rebuilt image (`images/hermes`) and upgrade self-hosted installs together.
7. **Reef: upgrade by replacing the image.** The plugin is baked read-only at
   `/opt/hermes/plugins/platforms/clawbits`, `HERMES_HOME=/opt/data` is the only persistent
   state, and `reinstall.sh` now refuses to run there (exit 2). Every new plugin file must
   be committed before an image build: the image bakes `git archive HEAD:extensions/hermes`
   and its smoke test imports them.
8. **Self-hosted: `reinstall.sh` upgrades in place.** It never touches identity or state and
   rolls back on a failed doctor. Rolling code back is safe for the journal (an older plugin
   refuses a newer schema); rolling it back does not re-send accepted work.

## Verification

```sh
# Plugin and backend-library suites (stub-imported Hermes; one process only)
.venv/bin/python -m pytest tests/poc tests/email -q

# Include the real-cron automation catch-up cases (needs the read-only reference checkout)
PYTHONPATH=hermes-agent PYTHONDONTWRITEBYTECODE=1 \
  .venv/bin/python -m pytest tests/poc/test_hermes_automations_catchup.py -q

# Backend email API (needs the compose services)
docker compose -f compose.yaml -f compose.override.yaml up -d --wait db redis stalwart
uv run pytest tests/fastapi/test_email.py tests/fastapi/test_email_incremental.py \
  tests/fastapi/test_email_outbox.py tests/fastapi/test_version_check.py -q

# Real Hermes runtime matrix: both pins x both plugin layouts
env -u INVOCATION_ID scripts/hermes_runtime_tests.sh min current

# Lint and the generated schema doc (CI diffs the result; it must be unchanged)
uv run ruff check .
uv run python -m clawbits.db.render_schema && git diff --exit-code clawbits/db/db_schema.md

# Frontend (the onboarding prompt asserts reinstall.sh --restart-default)
cd frontend && bunx vitest run src/lib/agentPrompts.test.ts && bun --bun run build

# Image recipe lint
cd images && for f in */Dockerfile; do docker buildx build --check --build-arg BASE=alpine "${f%/Dockerfile}"; done
```

Known noise: `tests/hermes_runtime/test_commands.py::test_new_creates_fresh_session` is
flaky at baseline, and the local Stalwart applies an hourly per sender-domain and recipient
rate limit, so repeated full runs of `tests/fastapi/test_email.py` within an hour fail with
`smtp_452` even when the code is correct.
