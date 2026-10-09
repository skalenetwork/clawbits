# Hermes critical fixes — implementation plan

Prepared 2026-09-18 from [the extension review](HERMES_EXTENSION_REVIEW.md). This is a proposed implementation plan; fixes and rollout have not started.

Updated against reference Hermes `0d0ccb88342e11fba13d0c53498f04f10a6ba137`, compared with the review's `1c121280ac`. This update is a source/diff review, not a runtime compatibility certification. `hermes-agent/` remains read-only; implementation targets are the extension, Clawbits backend, packaging, and tests in this repository.

Target: prevent unauthorized work, lost messages, leaked credentials, and unsafe upgrades. Preserve existing chat/email capabilities. Usage reporting, skills/model sync, richer automations, arbitrary email recipients, and general media parity follow this work.

**Deployment requirement: all fixes must work in both self-hosted Hermes installations and Reef-based deployments.** Keep shared extension behavior and security guarantees consistent across both. Resolve installation paths, credentials, persistent storage, process supervision, and lifecycle operations through deployment-appropriate configuration; do not require Reef services for self-hosted operation. Document setup, upgrade, recovery, and any deployment-specific prerequisites for both.

**Findings from the updated reference**

The original command, mail isolation, cursor, argv, SSRF, and upgrade findings remain applicable. Updating Hermes alone does not fix the extension paths. Native fixes below should be inherited and tested, not reimplemented in the plugin.

| Finding | Source evidence | Plan impact |
| --- | --- | --- |
| **P1: profile/account confusion risk in extension email tools.** `_send_email_tool()` and its availability check use launch-process `os.getenv`; CLI children copy all of `os.environ`. A routed profile can therefore use the launch account's credentials or inherit unrelated secrets. This is a source-confirmed unsafe lookup, not a demonstrated production cross-account send. | [Email tool](../extensions/hermes/email_integration.py), [CLI environment](../extensions/hermes/cli_client.py); upstream [profile child environment](../hermes-agent/tools/environments/local.py), [scoped secrets](../hermes-agent/agent/secret_scope.py) | Expand B; require profile-bound credentials/config, child environment, and background-task ownership before E. Upstream environment helpers do not protect subprocesses that bypass them. |
| Queued voice/audio/video/document events now retain independent FIFO turns; photo/text bursts may still merge when security context matches. | [Gateway queue](../hermes-agent/gateway/run_busy.py), [queue tests](../hermes-agent/tests/gateway/test_queue_consumption.py) | D/F must associate all source items with the correct turn. Preserve native merge rules; do not add a second media queue. Native FIFO support does not add missing Clawbits media delivery methods. |
| `/stop` and `/new` preserve parked internal wakes; async completions now check run generation and conditionally switch the expected session. | [Interrupt handling](../hermes-agent/gateway/run_agent_cache.py), [completion routing](../hermes-agent/gateway/run_notifications.py), [session switching](../hermes-agent/gateway/session.py) | A/D/F/G need stale-completion and internal-wake tests. Do not mark untrusted mail as `internal` or redirect old replies into a new session. |
| Cron delivery forces redaction for payloads, job names, and mirrors; the shared redactor handles additional dotted key formats. | [Cron delivery](../hermes-agent/cron/scheduler_delivery.py), [redactor](../hermes-agent/agent/redact.py) | B should reuse supported redaction and fail closed on diagnostic-preview failures. Extension activity and argv remain separate exposure paths. |
| Recurring cron resume retains overdue occurrences for scheduler catch-up policy. Clawbits cron expressions remain computed one-shots and reconciliation does not call `resume_job()`. Thus the native fix does not automatically cover this bridge. | [Native resume](../hermes-agent/cron/jobs.py), [bridge scheduling/reconciliation](../extensions/hermes/automations.py) | Add J: explicit missed-run behavior and regression coverage for pause/resume and edits. Preserve successful run outcomes after transient claim-heartbeat failures. |
| Failed transcript appends now spool stalled backlogs; repeated transcript lag becomes an error. These are transcript records, not a durable inbound work queue. | [Transcript storage](../hermes-agent/gateway/session_transcript.py), [turn history](../hermes-agent/gateway/run_turn_runner.py), [pending transcript spool tests](../hermes-agent/tests/gateway/test_pending_queue_spool.py) | Keep D's intake journal. Neither transcript presence nor absence alone proves a turn's completion or whether side effects occurred. Surface degraded persistence in I. |
| API-server runs keep shutdown interruption terminal; a new in-process wake path uses the owning profile's normal history, model, and tools. | [API run lifecycle and internal wake](../hermes-agent/gateway/platforms/api_server_runs.py) | Useful native lifecycle behavior, but not a Clawbits processing receipt or a restricted email executor. E must not use this path to bypass reader isolation. |
| Discord now separates its model-only triggering-message note from authored transcript text. Clawbits `channel_context` is still inserted into model text and is not removed by that Discord-specific logic. | [Inbound context](../hermes-agent/gateway/run_inbound.py), [persisted user content](../hermes-agent/gateway/run_turn.py) | A must check transcript/search/memory content separately from command parsing. Moving context fixes parsing, but does not itself guarantee clean persisted history. |
| Health now detects stale heartbeat with a live PID; idle suspension considers served-profile adapters and failed/reconnecting platforms. Profile home expansion and old optional-table schema handling also improved. | [Runtime status](../hermes-agent/gateway/status.py), [suspend gate](../hermes-agent/gateway/run_shutdown.py), [home resolution](../hermes-agent/hermes_constants.py), [profile DB operations](../hermes-agent/hermes_state_gateway.py) | I needs actual receipt/heartbeat checks, secondary-profile reconnect coverage, and legacy-state migration cases. Direct Clawbits polling requires an awake process unless a durable external wake path exists. |

Priority remains **P1 before wider deployment**: A, B's profile/secret boundaries, D/E's safe mail processing, and G's retry correctness. C enables D/G. H and I remain release gates for the security/upgrade fixes. J closes an existing automation compatibility risk; broader automation parity stays deferred. Scheduling behavior is source-traced and needs deterministic reproduction in J before changing policy.

**Design decisions**

- Keep commands as raw `MessageEvent.text`; move model context into `channel_context`. Never put email/post content into a system-prompt field.
- Authorize gateway controls using authenticated human ID **and** the resolved operator DM. Email, agent-authored posts, attention nudges, and shared-channel posts cannot approve tools or administer the gateway.
- Process email in a separate restricted profile/session. A new session alone does not separate profile memory, credentials, or tools.
- Resolve credentials, configuration, state paths, and task ownership for the active profile together. Missing routed-profile credentials must never fall back to the launch profile. A restricted profile is not by itself an operating-system sandbox.
- Keep durable receipt, processing outcome, and outbound delivery as separate states. Enqueue is not completion; SMTP acceptance is not delivery to the recipient's inbox.
- Reuse Hermes's outbound delivery ledger where its guarantees fit. Its current ledger is best-effort and cannot replace durable inbound storage or an SMTP outbox.
- Preserve old API behavior through additive endpoints/options. Deploy server support before depending on it in the extension.
- Use bounded work per poll, retaining continuation. Never discard unseen work merely because a batch limit was reached.

**PR sequence and dependencies**

| PR | Change | Dependencies | Completion gate |
| --- | --- | --- | --- |
| A | Real Hermes test harness + command/control fix | None | Real parser and busy gateway tests pass; untrusted controls denied |
| B | Profile-bound credentials + private payloads/activity | None | Two-profile isolation proven; synthetic secrets absent from argv/activity/logs |
| C | Incremental mailbox API + epoch checks | None | More than 1,000 messages drain without skips; old clients unchanged |
| D | Durable intake storage + email recovery/snooze | C; real harness from A | Crash/restart retains every admitted item |
| E | Restricted email execution and sender policy | A, B, D | Mail cannot access owner memory/tools or resolve approvals |
| F | Forward chat recovery + ordered completion | D storage primitives | Poll/WebSocket races and large gaps lose no admitted messages |
| G | Durable email outbox + API idempotency | C, D, E | Retry reuses delivery record; ambiguous SMTP outcome stays visible |
| H | Pin image-download DNS to connection | None | DNS/redirect/TLS boundary tests pass |
| I | Identity-preserving upgrade and rollback | None; required before rollout | Two-profile upgrade preserves identity, state, and unrelated gateway |
| J | Automation catch-up and profile compatibility | A harness, B profile binding | Pause/resume accounts for missed slots; no wrong-profile jobs or false run outcomes |

Each row is a reviewable work package. Split C/D/G into API/storage/adapter PRs if needed; avoid one cross-stack rewrite. A/B/H/I can land independently. Deploy D and E together for automatic email processing; do not enable durable backlog replay into the old unrestricted email path.

**A. Restore commands and protect control replies**

Root cause: `_build_agent_body()` prefixes all inbound text; Hermes's parser and prompt-reply handlers require the original text.

Files: `extensions/hermes/adapter.py`, `messages.py`, tests under `tests/poc`; reference `hermes-agent/gateway/platforms/event.py` and `gateway/run_inbound.py`.

1. Add a real-runtime integration test process, separate from the current tests that replace `gateway.*` in `sys.modules`. Use a temporary `HERMES_HOME`, a fake Clawbits HTTP service, and a deterministic model stub. Load the plugin through the actual Hermes loader.
2. Resolve operator identity from authenticated `agent_info` (`operator_id` exists) and the canonical operator-channel endpoint. A configured fallback channel is not proof that a sender owns the agent. Cache identity briefly; invalidate on configuration/ownership changes. If verification is unavailable, deny controls while preserving ordinary chat.
3. Leave trigger text in `MessageEvent.text`, apart from the existing intentional self-mention removal. Put trusted Clawbits description and separately framed historical/attention data into `channel_context`, consumed later by Hermes's model-input builder.
4. Set `allow_gateway_control=True` only for a verified operator's live DM message. Set it explicitly false for email, agent posts, attention, historical context, and other participants. A replayed old `/approve` must not authorize today's pending request.
5. Preserve raw short answers as well as slash commands: `yes`, numbered choices, and clarification replies must reach Hermes's pending-prompt handlers unchanged. Admit verified operator control messages before the ordinary snooze/turn queue gate, so `/stop` still works while paused or busy. Do not implement a second command parser in the plugin.
6. Test the actual supported minimum (`requires_hermes >=0.21.3`) and a pinned current revision. If required fields are absent at the minimum, explicitly raise the floor and update images together; do not silently drop security fields.
7. Inspect persisted user rows as well as model inputs. Preserve authored text and avoid repeatedly storing routing/history instructions as user-authored content. Use a supported metadata/model-input boundary if available; the Discord-specific stripping helper is not a generic Clawbits solution. If the runtime exposes no suitable boundary, record that compatibility limitation and keep the smallest bounded context required.

Acceptance tests:

- `/stop` interrupts a blocked turn, including while snoozed; `/new` creates a fresh session; `/model` and `/usage` reach their native handlers.
- `/approve` and clarification answers resolve only the intended active operator session.
- Identical text in email, shared channels, agent messages, forged display names, and attention events cannot resolve control prompts.
- Normal messages retain Clawbits context once; restart catch-up does not execute historical commands.
- `/stop`/`/new` preserve legitimate parked native wakes, while stale completions cannot re-pin the previous session or resolve a new approval. Email and external attention events never gain the internal-wake trust bypass.

**B. Bind profile credentials; remove private data from arguments and activity**

Root cause: email tools resolve identity from process-wide environment; child CLI environments copy unrelated secrets. Email bodies use private temporary files, but chat POST/PATCH and status payloads still use argv. Activity uses incomplete pattern redaction.

Files: `extensions/hermes/cli_client.py`, `email_integration.py`, `adapter.py`, background poll/reconcile startup, `agent-cli/clawbits_agent_cli.py`.

1. Extract the existing email private-JSON-file behavior into one helper: mode 0600, cleanup on success/error/cancellation, no payload in filenames. Prefer this small fix before replacing the whole transport.
2. Route all private JSON payloads through it: chat posts, streamed replacements, activity, automation specs, and email. Audit remaining string arguments for correspondence or secrets. CLI should continue supporting existing manual invocations.
3. Emit tool-name/action-only activity by default. Any optional argument preview needs a structured allowlist plus credential redaction. Treat length limits as volume controls, not privacy controls.
4. Scrub exception URLs, authorization headers, signed attachment URLs, and response bodies before logs or user notices. Keep structured status/error codes useful for diagnosis.
5. Resolve endpoint, agent ID, API key, challenge answer, receive/send policy, and state home from the owning profile. Bind that owner when creating poll, automation, retry, and send tasks; do not depend on whichever scope happens to be active later. Use supported scoped secret/config APIs with a compatibility check. Never change global `os.environ` to switch profiles; missing scope/credentials must produce a typed unavailable state.
6. Build a minimal child environment with the owning profile's required Clawbits values and transport settings. Use Hermes's supported environment helpers where compatible, then explicitly add only required credentials. Do not pass provider keys to the HTTP CLI. Test shell/service-injected secrets as well as `.env` values; stripping only known `.env` names is insufficient.
7. Reuse the shared Hermes redactor for permitted diagnostic previews, with forced redaction where supported and a safe placeholder on failure. Keep the names-only default; do not redact request bodies before sending intended content. Test dotted keys and already-redacted masks. Native cron redaction should remain intact across live/standalone delivery and chat mirrors.

Acceptance: launch the real child CLI with synthetic data against the fake service; inspect argv, environment, emitted activity, and captured logs. Assert the payload reaches the server unchanged and secret strings appear nowhere else outside the intended credential channel. Verify temporary files remain private and are removed on failures. Run profile A → B → A in one gateway, plus concurrent tasks: each request uses its own endpoint/account/key/state; missing B credentials cannot use A; disabled B send policy cannot inherit A's enabled policy. Test email-tool availability inside and outside a bound scope.

**C. Add an incremental mailbox contract**

Root cause: offset pagination is newest-first; UIDVALIDITY is absent from the API; reading a message also marks it read.

Files: `clawbits/datastructures/email_models.py`, `clawbits/email/imap_client.py`, `clawbits/fastapi/email_endpoints.py`, route registration, bundled Hermes CLI/client, `tests/fastapi/test_email.py`.

Proposed additive API:

```text
GET /api/agentic/agents/{agent_id}/email/changes
    ?after_uid=120&uidvalidity=456&through_uid=900&limit=50

{
  "uidvalidity": 456,
  "through_uid": 900,
  "emails": [... ascending UIDs strictly greater than 120 ...],
  "next_after_uid": 170,
  "has_more": true
}
```

1. Read UIDVALIDITY and a stable upper bound from the selected mailbox. On the first request, derive `through_uid` from that mailbox snapshot; later requests use the same bound. New arrivals belong to the next scan.
2. Restrict the IMAP UID search to `(after_uid, through_uid]`, sort ascending, and enforce the bounds again on returned records. UIDs can have gaps; “contiguous” means all enumerated records, not consecutive integers. Avoid the IMAP `n:*` edge case returning an older highest UID when `n` exceeds the mailbox maximum.
3. Return explicit epoch mismatch (`409` with a stable code and current epoch). Check epoch on message-detail fetches too, so a mailbox reset between list and fetch cannot substitute different mail under the same UID.
4. Add `mark_read=false`/PEEK behavior for adapter fetches; preserve existing get-and-mark-read defaults for current tools/UI. Processing status must not be inferred from the mailbox's `Seen` flag.
5. Register `/email/changes` before the dynamic UID route. Reuse mailbox ownership checks, pagination bounds, error translation, and billing rules.
6. Retain existing newest-first inbox endpoints for OpenClaw/UI. Expose whether incremental/epoch-aware reads are supported. On an older backend, pause automatic mail ingestion with an actionable diagnostic rather than silently reverting to the lossy path.

Acceptance: 1,002 and 10,000 messages; arrivals/deletions during a scan; sparse UIDs; mailbox reset before listing and between list/fetch; empty mailbox; no unintended read flag changes; old clients receive their existing response behavior.

**D. Persist intake before dispatch; recover without skipping**

Root cause: email's JSON watermark advances on enqueue; chat advances delivery cursors before all earlier outcomes are known. In-memory reply context cannot survive restart.

Files: new focused `extensions/hermes/inbox_state.py`; `adapter.py`, `email_integration.py`, `read_cursors.py`; dedicated persistence tests.

Use a plugin-owned SQLite database under the selected Hermes profile. Do not add tables directly to upstream Hermes's `state.db` without a supported ownership contract. Suggested minimum records:

| Record | Required data |
| --- | --- |
| Source position | Profile/backend/account/source identity, epoch, enumerated cursor, settled cursor |
| Inbound item | Stable source ID, immutable normalized input or durable reference, disposition, attempts, owning profile/session and run generation, error code |
| Reply intent | Inbound ID, output body, destination, threading headers, delivery key, delivery state |

States: `pending → processing → processed`; alternatives `retry_wait`, `ignored`, `deleted`, `needs_review`. Record reasons. `processed` means output/no-reply decision is durably recorded; outbound acceptance is tracked separately.

1. Namespace by canonical backend URL including any base path, stable agent/account ID, mailbox/channel, and profile. Do not use API keys in keys; rotation should preserve state. Include UIDVALIDITY for email. Event IDs must include the epoch so UID reuse does not collide with old reply contexts.
2. Atomically insert a page's items and advance its enumeration cursor. Only then dispatch. A failed DB write stops admission and leaves the remote cursor unchanged. Protect the state directory/database and attachment files; bound retained bytes and purge settled content after a defined retention period.
3. Use one active consumer per source initially. Persist processing ownership/run identity and verify actual gateway admission; a returned enqueue call is not proof of acceptance. Track input-to-turn association through Hermes queue merging/debounce and `ledger_message_id` changes. On restart, reconcile with Hermes's run/transcript/delivery records before replaying. A run that may already have performed external tool actions goes to `needs_review` unless completion can be proven; do not promise exactly-once tool execution.
4. Advance the settled cursor through every earlier enumerated item with a recorded disposition. A later successful item cannot hide an earlier failure. Explicit ignored/deleted items may settle; failed/unknown work remains visible and recoverable.
5. Persist email reply context and completed output. Delivery retries reuse stored output rather than invoking the model again. Limit queued bytes/items and apply backpressure without cursor advancement when full.
6. Snooze pauses new automatic chat/email dispatch and automatic follow-up sends. Continue bounded durable intake; leave excess upstream. Already accepted SMTP delivery cannot be recalled. Already-running turns follow the existing cancellation policy; `/stop` remains separately available to the verified operator.
7. Separate receive/send policy in profile config and make tools use resolved profile credentials. Preserve `CLAWBITS_EMAIL_ENABLED` as the legacy receive switch; document the new independent send switch.
8. For vanished mail, settle a 404 only after confirming the same epoch. Retry temporary errors with bounded backoff; configuration failures become recoverable degraded state rather than permanently terminating the loop.
9. Retain input-to-turn associations for photo/text merges and separate FIFO turns for voice/audio/video/document events. Do not settle every queued item when only the merged head completes. Use supported lifecycle outcomes; `_gateway_accepted` is only admission. Do not inspect Hermes's private pending dictionaries as a durable completion API.
10. Treat transcript append/spool lag as uncertainty, not failed execution. Reconcile using explicit run outcomes and persisted reply intents; do not auto-replay solely because a transcript row is missing. Native API-server shutdown status does not cover the Clawbits adapter automatically. If an unambiguous completion hook is unavailable at the supported minimum, leave the record unresolved and raise the compatibility floor or hold processing.

Migration: preserve original watermark/cursor files. Adopt a legacy UID only when backend/account/epoch binding can be established. Otherwise show `migration_needs_review` and hold automatic replay; do not silently seed to newest or replay the entire inbox. On a real epoch change, start a new namespace and enumerate its contents through the restricted reader. For a genuinely new installation, explicitly record the configured first-start choice (`new_only` default or bounded backfill).

Acceptance: terminate the test process after fetch, DB commit, enqueue, model completion, and saved reply; restart and account for each item. Include disk-full/corrupt-state behavior, later-item success before earlier failure, identity rotation, two profiles, queue limits, and snooze/resume. Previously skipped historic mail cannot be reconstructed from the old watermark alone; recovery requires an explicit replay selection.

**E. Make email a restricted execution surface**

Root cause: email shares the owner's privileged session; a body fence and a matching `From` address provide no enforced execution isolation.

Files: new focused email-reader/policy module inside `extensions/hermes`; `adapter.py`, `email_integration.py`; backend mail metadata only where trusted verdicts can be supplied.

1. Run an isolated reader profile with no owner conversation history, memories, workspace mount, Clawbits API key, terminal/browser/network tools, delegation, scheduler, or send tools. Supply only the email data and provider access required to generate a bounded result. The trusted dispatcher performs delivery outside the model.
2. Establish the effective tool set through a supported Hermes runtime boundary and test it. **Do not rely on `toolsets_for_source() -> []`: the current resolver treats an empty override as false and falls back to normal tools.** Do not assume tool removal also disables memory loading, implicit skill discovery, MCP, plugins, or environment inheritance.
3. Until that restricted boundary is demonstrated on both supported Hermes versions, retain mail in the durable inbox and show a plain “mail waiting for review” notice. No privileged-model fallback. Record any missing upstream capability as a compatibility requirement; do not patch the reference checkout. Prefer a supported isolated worker/API configuration, subject to the same isolation tests, or wait for an upstream capability.
4. Keep email `allow_gateway_control=False` regardless of sender. Put body, subject, addresses, dates, and attachment names in one untrusted structured input. Enforce body/attachment count, decoded-byte, and output-size limits before allocations/dispatch. Stage only selected attachments, never shared host paths.
5. Treat `From` as presentation data. If sender-authentication metadata is exposed, derive it from the receiving mail server's trusted boundary, strip forged results at ingress, and return a typed verdict (`pass`, `fail`, `unknown`). A DKIM/SPF/DMARC result alone must not grant general owner control. Authentication-Results headers require a trusted producer/consumer path. [RFC 8601](https://www.rfc-editor.org/rfc/rfc8601.html#section-1.2).
6. Preserve the existing owner-only outbound address restriction. An authenticated owner-mail workflow may receive a restricted conversational answer; third-party mail produces a summary for review and no reply to the sender. If verification is unknown, hold automatic emailed replies and expose the reason. Suppress auto-reply loops separately from optional newsletter ingestion.
7. Post reader output as an untrusted artifact through the trusted dispatcher; do not inject it as a new instruction into the owner agent. To perform actions, the owner explicitly requests a task through authenticated chat, subject to normal tool approvals. A bare “approve this email” must not authorize every embedded instruction.
8. Apply a global per-mailbox token/work budget and queue limit, not only per-From limits that attackers can bypass by rotating addresses. Never discard queued mail when a budget is exhausted.
9. Keep `internal=False` for mail-derived gateway events. The new `run_internal_session_turn()` is an owner-session wake with normal history/tools, not a mail sandbox. Give the reader only its own required provider credential through B's scoped boundary; the dispatcher retains mailbox credentials. Prove effective memory, skill/plugin discovery, filesystem, environment, and network restrictions rather than assuming a named profile provides them.

Acceptance: hostile body/subject/filename requesting filesystem reads, outbound HTTP, memory lookup, tool execution, forwarding, and `/approve` cannot invoke those capabilities. Forged Authentication-Results cannot earn trust. Ordinary owner mail still receives the allowed restricted reply; third-party summaries and attachments remain reviewable. Verify profile A → reader → profile A without state/tool leakage.

**F. Recover chat gaps through the same ordered intake model**

Root cause: normal polling uses a newest-50 window; WebSocket events and polling mutate shared cursors independently.

Files: `extensions/hermes/adapter.py`, `cli_client.py`, `read_cursors.py`, `messages.py`.

1. Use the existing `after_post_id` read in normal polling and after every reconnect. Read oldest-first into D's durable intake store. Retain a continuation when a page/time budget is reached; never jump to the newest post to end a large gap.
2. Route poll and WebSocket admissions through one per-channel serialized path. A WebSocket event for post 100 must not advance enumeration past unobserved post 99. Treat events as wakeups/hints or persist them independently until the intervening range has been enumerated. Deduplicate by backend/account/channel/post ID.
3. Separate enumeration, processing, and server read acknowledgement. Acknowledge only the settled prefix. Preserve intentionally ignored posts as dispositions without permanently suppressing a later eligible attention event; attention references the original post and has its own admission reason.
4. Keep existing consolidated startup catch-up where intentional, but do not mark every historical instruction individually executed. Record which items were summarized and which triggered a turn. Commands/approvals in historical context remain non-executable.
5. Use a small concurrency bound across channels and one ordering owner within each channel. A slow attachment download or failed channel must not stop control-message admission and unrelated channels. Model dispatch can remain session-serialized.
6. Preserve native generation/session ownership checks when dispatching queued work and handling completion. After `/new`, `/resume`, or `/stop`, a late prior turn must not clear a successor's activity, advance its acknowledgements, or move the current route. Bind any allowed old-turn delivery to its original durable destination; apply the explicit cancellation policy before sending.

Acceptance: more than 50 missed posts, a 10,000-post recovery, event 100 arriving before poll 99, duplicate WebSocket events, reconnect during a turn, failed earlier turn followed by success, attention after initial skip, and slow downloads in another channel. Every eligible item has a durable outcome or pending record.

**G. Add an email outbox with honest delivery status**

Root cause: SMTP send and chat mirror are independent side effects; no persistent delivery record or API idempotency contract exists.

Files: `clawbits/email/smtp_client.py`, `fastapi/email_endpoints.py`, `datastructures/email_models.py`, DB model/migration/table helpers, extension email/client/delivery code.

1. Add an optional `Idempotency-Key` contract to email send and a mailbox-owner-scoped delivery-status endpoint. Uniquely constrain `(agent/account, key)`; store a payload hash and reject reuse with different content (`409`). Check existing requests before repeat billing. Legacy callers retain their current contract.
2. Derive automatic reply keys from durable inbound identity and reply version, not body text. Explicit send-tool calls use a persisted logical action ID. Different intended messages with identical text remain distinct.
3. Commit the outbox row before SMTP. Serialize claims across server workers with a durable lease. Use states `queued`, `attempting`, `accepted`, `retry_wait`, `failed`, `unknown`. Set `attempting` before the network side effect; never blindly reclaim an expired attempting record as unsent.
4. Give the message a stable Message-ID for tracing, but do not treat it as a recipient-side deduplication guarantee. Retry definitive pre-acceptance temporary failures with limits. Permanent rejection is visible. If the process/connection dies after submission may have succeeded, record `unknown`; reconcile against trustworthy MTA evidence if available, otherwise require an explicit retry decision.
5. Distinguish queued, SMTP-accepted, and failed/unknown delivery in the UI/logs. Never label accepted mail “delivered to inbox.” Duplicate API calls return the same delivery record. SMTP timeouts can cause duplicates; an HTTP idempotency key cannot by itself make SMTP exactly-once. [RFC 5321](https://www.rfc-editor.org/rfc/rfc5321.html#section-4.5.3.2.6).
6. Separate the chat mirror from email delivery. Retry either without regenerating the answer or repeating the other. Persist mirror post IDs/draft IDs. `client_msg_uuid` is currently an optimistic-UI echo, **not** durable server deduplication; if retrying uncertain post creation, add and test a real uniqueness contract or retain an explicit unknown state.
7. Ensure Hermes's own delivery-ledger replay resolves the same outbox/mirror record. Restored sends must not depend on `_email_reply_contexts` surviving in RAM. Check streaming finalize and non-streaming paths; one outcome record owns both.
8. Add finite SMTP connect/read deadlines and require the configured TLS mode before authentication. Current explicit-TLS code continues when STARTTLS is absent; replace that fallback with a typed failure. Keep intentionally insecure test/local-relay configuration explicit.
9. Persist owning profile, source session/run, and destination with the reply intent. Recovery must never derive these from the current chat route or launch environment. Hermes's ledger may replay ambiguous sends with a visible marker and is best-effort; translate that replay into lookup of the same outbox identity, not another SMTP submission. Do not rely on current optional ledger columns existing in old profile databases.

Acceptance: duplicate/concurrent requests, changed payload under one key, crash before/after outbox commit, before SMTP, after DATA acceptance, after lost HTTP response, partial mirror failure, and Hermes redelivery after restart. One logical request retains one server record; ambiguous network outcomes remain visible rather than being silently resent.

**H. Pin image download addresses**

Root cause: hostname validation and connection resolve DNS independently.

Files: `extensions/hermes/media.py`; relevant tests. Reference existing `clawbits/ssrf.py::PinnedAsyncTransport` and link-preview tests.

1. Reuse the existing validated-address/SNI-preserving transport design. Make the small required helper available in the standalone plugin artifact without importing the full Clawbits backend; use a focused shared module/build inclusion and packaging test.
2. Validate HTTP(S), destination, and every redirect; connect only to vetted addresses. Preserve the original hostname for certificate checks and Host/SNI. Retry only among the vetted set.
3. Explicitly handle proxy environment variables; a proxy must not re-resolve an unchecked hostname and defeat local validation. Retain exact configured private-host exceptions without extending them to redirect destinations.
4. Preserve per-file byte/time/redirect limits and enforce the cap while streaming. Avoid forwarding authentication headers across origins. Keep trusted backend presigned attachment access distinct from model-authored image URLs.

Acceptance: public-to-private DNS change, mixed public/private answers, IPv4/IPv6, redirect to loopback/metadata, TLS hostname failure, oversized response without Content-Length, proxy configuration, allowlisted self-hosted provider, and normal public images. Exercise the transport connection boundary, not just the URL validator.

**I. Ship fixes without resetting the agent**

Root cause: normal redeploy instructions call a script that erases credentials and can stop unrelated gateways.

Files: `extensions/hermes/reinstall.sh`, `README.md`, setup/doctor command module, image smoke tests.

1. Add a normal upgrade mode preserving all identity/config/cursor/queue data. Keep destructive reset a separately named operation. Remove broad `pkill`; target only the selected profile/service.
2. Stage plugin files, validate manifest/imports/CLI and Hermes compatibility, then atomically switch. Keep the prior version until a health check succeeds. Do not delete the working install before validation.
3. Back up and version state migrations; preserve old data until conversion is proven. Prevent old plugin versions from consuming a new journal they cannot understand. Code rollback must not restore stale cursors and re-send already accepted work.
4. Add diagnostics for identity, effective command policy, reader isolation, mailbox epoch, queue depth/oldest age, stalled records, last successful poll, and outbox unknown/failed counts. Redact all credentials and mail content.
5. Include upstream heartbeat age, degraded/watchdog state, transcript lag, and actual successful Clawbits receipt in health checks. A live PID or successful liveness POST is insufficient. Do not restart repeatedly on a recoverable mailbox fault; show which subsystem is degraded.
6. Exercise native idle-suspension policy with Clawbits in the primary and a served profile, including reconnect failure. Poll/WebSocket adapters must keep the process awake unless a separate durable ingress/wake mechanism is configured. Use runtime home helpers for profile state; test expanded `~`/environment paths and old optional-table schemas during profile maintenance.

Acceptance: upgrade profile A while B is running; verify A keeps identity/settings/queue and B is untouched. Inject invalid package, failed health check, interrupted migration, and rollback. Deployment success requires preserved state and working message receipt, not just an import passing.

**J. Preserve automation scheduling and ownership across the runtime update**

Root cause: the bridge computes cron occurrences as one-shots and resumes through `update_job()`/rearming, bypassing native recurring `resume_job()` behavior. `_next_schedule_ms()` retains only enabled, future occurrences; reconciliation can replace an overdue occurrence during resume or another edit. Native whole-minute intervals follow a different path and must be tested separately.

Files: `extensions/hermes/automations.py`, adapter task startup, automation regression tests. Reference `hermes-agent/cron/jobs.py`, `cron/scheduler.py`, and `cron/executions.py` without modifying them.

1. First reproduce pause across a due slot and unrelated edits after a missed slot using a fixed clock and real cron APIs. Cover cron expressions, whole-minute native intervals, non-native intervals, and one-time jobs. Record current behavior before choosing the minimal change.
2. For a managed recurring schedule, retain the pending occurrence until an explicit catch-up/skip decision is recorded. Respect the documented configured policy; bound catch-up to avoid a backlog burst. Use native resume semantics where the native recurring representation matches. For computed one-shots, persist the missed-slot decision before advancing; preserve per-job timezone/stagger and DST behavior.
3. Preserve completed one-shot protection and manual run generation deduplication. Schedule edits must not re-execute a completed slot accidentally; prompt/name edits must not restart interval cadence. Keep execution outcome separate from delivery outcome and temporary fire-claim heartbeat failures. Prefer the real execution record; expose uncertainty when only legacy summaries are available.
4. Bind every reconcile and native cron API call to its owning profile through B. The module's existing “Hermes is single-account” comment is not a safe assumption for multiplex gateways. Validate unsupported `agentId`/`sessionKey` targeting rather than silently accepting a cross-profile request; keep the supported contract explicit.
5. Reuse native incident grouping/cooldown for failure notifications where applicable; do not turn a suppressed repeat alert into a successful execution or add a parallel alert flood.

Acceptance: missed occurrence fires once or has an explicit skipped disposition; resume never silently jumps over it. Include DST transitions, restart between decision and rearm, run-now while paused/completed, transient claim loss after completed delivery, and two profiles with identical automation IDs. No job, report, or reply crosses profiles.

**Verification commands and environment**

Existing regression commands:

```sh
.venv/bin/python -m pytest tests/poc/test_hermes_extension.py -q
.venv/bin/python -m pytest tests/fastapi/test_email.py -q
.venv/bin/python -m pytest tests/link_preview -q
git diff --check
```

The FastAPI email suite requires isolated PostgreSQL/Redis/Stalwart test services; follow `.github/workflows/workflow.yaml` for the fixture environment. Never point failure-injection tests at live mailboxes. PR A must add a CI command that runs its real-runtime suite inside separately pinned minimum/current Hermes environments, without mixing the stub-import tests into that process. Commit the existing scratch reproductions as maintained regression tests in their owning suites.

Minimum release matrix: self-hosted and Reef-based deployments; both supported Hermes versions; streaming on/off; empty and populated profile; one/two profiles; healthy/disconnected WebSocket; owner/third-party/spoofed email; snoozed/active; supported/older backend; writable/full state disk. No production provider calls are needed for deterministic tests.

Release gate for both deployment types: verify installation, chat/email, restricted-reader isolation, automations, restart recovery, durable state retention, upgrade, and rollback. Include container replacement for Reef and the documented service restart/upgrade path for self-hosted installations. Record the tested runtime/image version and configuration for each; success on one deployment type does not satisfy the other.

Upstream regression references for A's isolated harness: `tests/gateway/test_queue_consumption.py`, `test_interrupt_keeps_parked_internal_wake.py`, `test_async_delegation_session_binding.py`, `test_api_server_active_work_drain.py`, `test_pending_queue_spool.py`, `test_discord_triggering_note_persistence.py`, `test_scale_to_zero.py`, `test_status.py`; `tests/cron/test_cron_delivery_redaction.py`, `test_fire_claim_lost_after_delivery.py`; and `tests/tui_gateway/test_served_profile_child_env_authority.py`. These describe native contracts; add Clawbits-specific assertions rather than assuming upstream tests cover this adapter. Run against disposable runtime copies/containers, with caches and temporary homes outside the reference checkout.

Current revision is a pinned candidate, not an approved minimum or verified deployment image. Record exact runtime/image SHA in test results. No runtime suites were rerun for this documentation update; earlier stub-suite results do not certify the updated runtime.

**Rollout and exit criteria**

1. Ship A/B/H and I's upgrade mechanism first. Validate C/G's additive server migrations in staging before deploying server support; old OpenClaw/UI clients must pass unchanged.
2. Enable D/E together on one isolated test agent, then a consenting canary deployment. Restriction checks must fail closed, retain pending mail, and show why processing is paused.
3. Run deterministic crash/backlog/security cases and J's automation compatibility checks before a 24-hour canary. Monitor queue age, loss/duplicate incidents, policy denials, SMTP unknowns, auth failures, poll latency, stale heartbeat/transcript lag, and missed automation slots without logging contents.
4. Expand to a small cohort, then all Hermes agents. Pause expansion on unexplained cursor jumps, unauthorized tool exposure, duplicate sends, accumulating unknown deliveries, or migration errors.
5. Roll back code only through the compatible state-preserving path. If compatibility is uncertain, pause dispatch and retain queues/outbox for repair rather than reverting to legacy lossy processing.

Done means: verified operator controls work; untrusted mail cannot use privileged context/tools; requests and background work stay in their owning profile; every admitted item has a durable disposition; restarts and large backlogs do not silently skip work; retry identities survive restart; uncertain deliveries remain visible; secrets stay out of argv/activity and unrelated child environments; image connections honor the checked destination; upgrades preserve identity and state; managed automation slots are executed or explicitly accounted for.

After these gates pass, replace hot-path subprocess requests with a pooled async HTTP client and benchmark CPU/request volume/p95 latency. Keeping that larger performance refactor separate reduces the risk of mixing transport regressions with the critical correctness fixes.
