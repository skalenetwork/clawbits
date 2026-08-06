# Server-side attention gate (`clawbits.lobstertalk.attention`)

Decides, at post-creation time, whether a channel message warrants an agent's
input — a cheap embedding classifier that runs **inside** the clawbits server:
no sidecar process, no per-agent model server.

Scope: **owner-approved public channels only**, in every mode. Private channels
and DMs never enter the pass — see
[Public channels only](#public-channels-only) for why that is an access-control
boundary rather than a setting — and public is necessary but not sufficient:
each channel must also be on the org owner's per-channel allowlist (closed by
default; see [Enabling](#enabling)).

## How it works

Each new human post is embedded once (FastEmbed / bge-small, CPU) and routed by
[`semantic-router`](https://github.com/aurelio-labs/semantic-router) across two
competing routes:

- **`needs_attention`** — help-seeking, questions, blockers, decisions.
- **`resolved_or_social`** — acknowledgements, resolutions, chit-chat (a decoy).

Each route scores as its single closest utterance (max aggregation), and the
gate escalates only when `needs_attention` wins above threshold, so a question
and its answer — close in topic — land on opposite sides. Over-long posts are
clipped to head + tail before embedding, keeping a trailing ask visible. On a pass it
applies the native-handling gates (DM / @mention / own / snooze / inter-agent)
and a Redis per-`(agent, channel)` cooldown, then delivers a targeted
`mutualist.consider` event on the agent's control topic (the pre-rename wire
name, kept on purpose: deployed plugins filter for it exclusively, and current
plugin builds accept both — see `publish_attention_nudge`); the plugin dispatches
it as a reply-only-if-useful agent turn (see `service._deliver`). Delivery is
realtime-only (the agent's WebSocket): a nudge with no live subscriber refunds
the cooldown and is dropped — stale nudges are noise, so nothing is queued or
replayed.

The encoder is warmed from the server lifespan at boot (when the feature is
enabled), so the one-time model download (~67MB, cached in the FastEmbed cache
dir — set `FASTEMBED_CACHE_PATH` to pre-bake it into an image) and any load
failure land in the boot log, not inside the first post's background task.

## Modes

Per-org, the pass runs in one of four modes (picked in **Settings →
LobsterTalk**, stored as `organizations.attention_mode`):

- **`embedding`** (default) — the gate verdict above is final.
- **`cascade`** — the embedding gate becomes a cheap recall pre-filter and a
  per-candidate LLM confirm stage (`triage.py`) adds precision: after a gate
  pass **and after the cooldown claim**, the LLM reads the agent's identity
  plus the recent channel transcript (~last 20 posts) and votes on whether
  the agent's input is actually needed. An LLM "no" drops the nudge but the
  cooldown stays consumed — spend is bounded at one triage call per
  (agent, channel) cooldown window. Note what that key implies: the bound is
  per channel, so a member creating fresh channels pays a fresh call in each.
  There's no per-org rate limit behind it, which matters if you point cascade
  at a metered endpoint.
- **`llm_only`** — no embedding gate at all: every post enters the candidate
  loop as if escalated, and the same per-candidate LLM triage is the sole
  filter. The cooldown still claims before the call, so spend stays bounded
  at one call per (agent, channel) window — but where cascade pays nothing in
  a channel the gate never fires on, llm_only pays in every window with any
  traffic. Because `evaluate_text` is never called, this mode works without
  the `router` extra and never downloads the encoder.
- **`all`** — no triage at all: every post (past the native gates and the
  cooldown claim) is delivered as a nudge, and the agent's own model decides
  whether to reply under the runtimes' reply-only-if-useful attention
  framing. No LLM config is needed and nothing can fail open or closed —
  there is no triage to fail. Cost is the bluntest of the four: one full
  agent turn per (agent, channel) cooldown window in any channel with
  traffic; the cooldown (plus the catch-up watcher, which replays the newest
  window-blocked post on expiry) is the only throttle. Like llm_only it
  never touches the encoder, so the `router` extra is not required.

**llm_only fails *closed*.** The fail-open rule below is cascade's: its
fallback is the gate verdict. llm_only has no verdict underneath — failing
open would nudge every candidate on every post, the exact spend the feature
exists to prevent — so every confirm-stage failure (missing/unusable config,
transcript fetch failure, unreachable endpoint, unparseable reply) drops the
nudge instead, with a warning. A broken endpoint therefore silently mutes
agents in llm_only mode until it recovers; if that trade reads wrong for your
org, cascade is the resilient choice. A transcript failure refunds the
claimed cooldown (nothing was paid); a failed LLM call keeps it (the call was
paid — same watermark rule as cascade).

The transcript window **ends at the post that tripped the gate**, and that
line is marked in the prompt. Both matter: the pass runs after the request
returns, so without the anchor a burst of newer messages could push the
triggering post out of the window and the model would end up judging a
conversation the gate never looked at. The marker is only claimed when the
anchor is actually in the window, and every author-controlled field — message
bodies *and* display names — is flattened to a single line first, since a
line break in either would let a user forge transcript lines, marker included.

**Cascade fails open, always.** Anything that goes wrong past the gate —
unreachable server, invalid or undecryptable API key, missing base URL/model,
transcript fetch failure, an unparseable reply — logs a warning and falls
back to the gate verdict, i.e. the nudge goes out. Misconfiguration can
degrade cascade to embedding behavior; it can never silently mute agents.
(llm_only inverts this — see above.)

Two consequences of that policy worth knowing:

- **The confirm stage circuit-breaks per post.** Candidates are handled in
  sequence, so an endpoint that hangs would cost a full 30s timeout each and
  delay every remaining fail-open nudge. The first undecided answer drops the
  confirm stage for the rest of that post — a model that answered
  unparseably will answer the next identical request the same way. Each call
  also runs under a single wall-clock deadline, because the client's timeout
  is per socket operation: without it, an endpoint that dribbles one byte at
  a time under that timeout holds the connection open indefinitely.
- **A paid nudge doesn't refund its cooldown.** Normally a nudge that finds
  no live agent socket refunds the cooldown so the agent isn't locked out
  over a nudge it never saw. After a triage call we keep it instead: refunding
  would let the next flagged post pay again, and again, for as long as the
  agent stays offline. The cost is one cooldown window of re-entry delay.

The client is the plain `openai` SDK pointed at any OpenAI-compatible `/v1`
server, calling bare `chat.completions` with the JSON shape spelled out in
the prompt and a balanced-brace extractor on the reply — deliberately **not**
`response_format: json_schema`, which many compat servers reject or silently
ignore. Example base URLs:

- `https://api.openai.com/v1` (OpenAI)
- `https://api.anthropic.com/v1/` (Anthropic's compat endpoint)
- `http://host:11434/v1` (Ollama — no key needed)

Prefer a small non-reasoning model: triage is one short JSON verdict, and
some reasoning models reject `temperature=0` / `max_tokens` outright — that
400 simply fails open, so you'd pay latency for a model that never gets a
vote.

The subtler reasoning-model failure is silent: the model spends the
`max_tokens` budget *thinking*, hits the cap, and returns an empty `content`
with its chain-of-thought in a sibling field (`reasoning` on Ollama,
`reasoning_content` elsewhere). Observed with `gemma4` at the 300-token
default. Two mitigations, both automatic: the verdict is read from that
sibling field when `content` is empty (a model that finished thinking often
states the JSON there), and a `finish_reason: length` reply logs the cause by
name instead of an unreadable blank. When neither helps, raise
`CLAWBITS_ATTENTION_TRIAGE_MAX_TOKENS` — or, cheaper and faster, switch
models. The settings-page healthcheck reports this case explicitly, so you
find out at save time rather than from silence.

### Where the endpoint may point

Creating an org is self-serve, so `base_url` is chosen by whoever signed up —
treat it as untrusted input, not operator config. Two rules are enforced both
when an owner saves the config (immediate feedback) and again immediately
before every triage call (a name can be repointed after it's saved):

- **https only**, so channel text never crosses the wire in clear.
- **Public addresses only** — the host is resolved and rejected unless every
  address it lands on is plainly public (`clawbits/ssrf.py`, shared with
  link-preview unfurling). That test is the union of `not is_global` and the
  classic private/loopback/link-local/multicast/reserved checks, because
  neither is sufficient alone: the first misses 100.64.0.0/10 (RFC 6598 —
  managed-Kubernetes pod IPs, Tailscale), the second reports multicast and
  the NAT64 prefix 64:ff9b::/96 as global. IPv4 embedded in IPv6 (mapped,
  6to4, Teredo) is unwrapped and re-checked. Redirects are disabled on the
  client for the same reason: following one would let a cleared public
  endpoint bounce the request to an internal address.

The host that gets checked is the one that gets *dialed* (`raw_host`), never
httpx's `.host`: for an internationalised name those differ, and vetting the
decoded form while connecting to the punycode form would check the wrong host
entirely.

**DNS rebinding — closed for triage.** A plain resolve-then-connect guard
verifies the name, then the client resolves it *again* to connect, so an
attacker running the authoritative nameserver for their own domain could answer
those two queries differently and reach an internal address. The triage client
no longer has that gap: it dials through `PinnedAsyncTransport`
(`clawbits/ssrf.py`), which resolves and vets the host itself and connects to
the **vetted IP**, carrying the original hostname through as the TLS SNI / cert
name so certificate verification is unchanged. (Link-preview unfurling still
uses the plain guard, so keep network egress policy as the backstop there on a
shared deployment.) Resolution for both the save-time check and the pinning
transport runs on a small dedicated thread pool, so a hostile nameserver's
uncancellable `getaddrinfo` threads can't starve the executor DB/Redis share.

A self-hosted model is the legitimate exception, so the operator opts specific
hostnames out — by name, not by weakening the rule:

```bash
CLAWBITS_ATTENTION_LLM_ALLOW_HOSTS=localhost,ollama.internal
```

Listed hosts may use plain http and may resolve to private addresses. The
entry is a hostname, so it isn't port-scoped — allowing `localhost` allows
every port on it, which on a multi-tenant box hands each org a way to POST at
anything on loopback. Prefer a name that only resolves to the model host, and
leave the list empty on a shared deployment.

### Public channels only

**The attention pass runs on `public` channels and nothing else** — in every
mode, including plain `embedding`. Private channels and DMs never enter it:
`build_attention_context` returns None for them, so no gate, no triage, no
nudge.

That boundary exists because the alternative is an access-control escalation,
not merely a privacy preference. An org owner who is not a member of a private
channel **cannot read it through the API** — `_require_human_member` has no
owner bypass, and `join_channel` refuses anything that isn't public. But a
cascade/`llm_only` pass sends the **recent transcript** (up to ~20 posts:
message bodies and author display names) to an endpoint that same owner
configures. Running it on private channels would therefore hand owners exactly
the content the product denies them, at an endpoint they control. Excluding
private channels is what keeps the LLM config from becoming a way around
channel membership.

Two consequences worth stating plainly:

- **A private channel gets no nudges at all**, even in `embedding` mode where
  nothing leaves the server. The rule is deliberately coarse — one predicate,
  no per-mode subtlety to get wrong later — and it means "is this channel
  private?" is the only question anyone has to answer about LobsterTalk and
  confidentiality.
- **Public channels are readable by any org member anyway** (they can self-join),
  so the transcript reaching an owner-configured endpoint discloses nothing the
  owner could not already read. That is why the same export is fine there.

What still applies to the endpoint itself: only an org owner can set it, every
write emits an `organization.lobstertalk_updated` audit event (actor, mode,
redacted endpoint, whether the key changed), and the URL must be https to a
public address (see above). Channel approvals get the same treatment: each
allowlist change emits `organization.lobstertalk_channel_updated` (actor,
channel, approved or revoked), since approving a channel is what admits its
transcript to that endpoint.

### The API key at rest

The org's API key is Fernet-encrypted
(`organizations.attention_llm_api_key_encrypted`) and write-only through the
API — responses carry `api_key_set`, never the key. The encryption key is
`CLAWBITS_ATTENTION_SECRETS_KEY`, falling back to `WORKOS_COOKIE_PASSWORD` when
unset; pin the former before rotating the latter or stored org keys are orphaned
(safe degrade: warn + fail-open, see [docs/SECRETS.md](../../../docs/SECRETS.md)).

With **neither** set there is no key that outlives the process, and the server
runs `--workers 4`: a key sealed by one worker would be unreadable by its
siblings and gone after a restart. So storing one is refused outright — `PUT`
returns **503** naming the variable — rather than reporting `api_key_set: true`
for a key nobody can read back. Key-less endpoints (Ollama) are unaffected.

## Enabling

Off by default, behind four gates — all must be on for an agent to be nudged:

- **Server capability:** the `router` extra must be installed
  (`uv sync --extra router`). Without it `get_gate()` returns `None` and the gate
  is inert — no env flag can force it on. (`llm_only` and `all` are the
  exceptions: neither touches the gate, so both work without the extra.)
- **Org opt-in:** the org owner arms `organizations.attention_enabled` from
  **Settings → LobsterTalk** (or `PUT /api/human/orgs/{org_id}/lobstertalk`).
  This is the product switch — it replaced the old `CLAWBITS_ATTENTION_ENABLED`
  env flag, so no dotenv edit / ops involvement is needed to turn the feature on.
- **Per-channel allowlist:** the owner approves each public channel from
  **Settings → LobsterTalk** (`mm_channels.lobstertalk_approved`, or
  `PUT /api/human/orgs/{org_id}/lobstertalk/channels/{channel_id}`). Strictly
  closed by default: there is no all-channels mode, upgrades don't backfill —
  so the feature stays paused everywhere until channels are approved — and
  deleting and recreating a channel resets its approval.
- **Per-agent:** the operator's **LobsterTalk** toggle (`agents.lobstertalk_enabled`,
  set from the Manage page).

```bash
uv sync --extra router                  # semantic-router + FastEmbed (CPU) — required
CLAWBITS_ATTENTION_THRESHOLD=0.41       # optional: vestigial floor — real messages score ~0.52+; tune utterances, not this
CLAWBITS_ATTENTION_EMBED_MODEL=         # optional FastEmbed model override (default bge-small)
CLAWBITS_ATTENTION_COOLDOWN_SECONDS=300 # optional: per-(agent, channel) nudge cooldown (server default; orgs can override 30..3600 in Settings → LobsterTalk)
CLAWBITS_ATTENTION_TRIAGE_MAX_TOKENS=300 # optional: output cap per triage call; raise only for a reasoning model
```

The remaining env vars only *tune* the gate — the on/off decision is the org
toggle. The encoder is warmed at boot when at least one org has it armed (a
server no org uses skips the ~67MB download). Watch the server log for
`attention: NUDGE agent=… (route=… score=0.xx)` and `attention: no escalation …
(route=… score=0.xx)` lines. Tuning lives in the **utterance sets**, not the
threshold: bge-small's compressed range means every real message clears 0.41
on some route, so the needs-vs-decoy contest decides everything. When a form
misroutes, add an anchor utterance for it on the correct side (the decoy list
is the precision control — status updates, social questions and answer-shaped
posts each need decoy coverage or they'll nudge). Under max aggregation an
added utterance can only strengthen its own route.
