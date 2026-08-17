# Skills Library - design plan

Status: **MVP built** (M1/M2/M3). Below is the design as implemented.

**One deliberate departure from §4:** the desired version is resolved LIVE in the
feed rather than stored on the install row. Publishing therefore takes zero row
locks and needs no fan-out across installs - an edit propagates because the
content hash changes, which the drift gate already detects. `desired_generation`
bumps only on intent changes (install / uninstall / enable). Verified end to end:
a publish moved an agent's on-disk skill with the generation still at 1.

Status: **locked for MVP.** Scope is the three slices in §8 ("MVP - build this").
Five decisions locked (§10a); the rest are deferred with the features that need
them (§10b). The two blocking unknowns were **verified on a live agent**
(§9) - new skill directories hot-reload with no restart, and a chat-installed
skill lands in the same persistent root we write to.

Goal: an org-owned library of agent skills that people can author, version,
fork, install onto their agents, and eventually share publicly - delivered to
the agent over the same inverted control plane the automations feature already
uses (Clawbits never dials in; the agent's plugin reconciles outbound).

---

## 1. What a skill actually is

Verified against OpenClaw docs (2026.6.x) and the four skills this repo already
ships in `plugin/skills/`.

A skill is a **directory** whose only required file is `SKILL.md`: YAML
frontmatter plus a markdown body. Required frontmatter is `name` and
`description`. `name` is 1-64 chars of lowercase letters, digits and hyphens,
and **must match the parent directory name**. Optional support files live in
`references/`, `scripts/`, `assets/`, `templates/`, referenced from the body
via a `{baseDir}` placeholder.

OpenClaw discovers skills from six roots, highest precedence first:

1. `<workspace>/skills`
2. `<workspace>/.agents/skills`
3. `~/.agents/skills`
4. `<state-dir>/skills` (i.e. `~/.openclaw/skills`)
5. bundled skills shipped with the install
6. `skills.load.extraDirs` **and** plugin-manifest skills (lowest, tied)

Our four `clawbits-*` skills ship at tier 6 via `"skills": ["./skills"]` in
`plugin/openclaw.plugin.json`. A user adds their own skill by a completely
different mechanism: dropping a directory into a root, or `openclaw skills
install`.

Skill identity is the flat frontmatter `name`, not the path. Nesting
`skills/acme/billing/` gives **zero** namespace protection. There is one flat
name space per agent, already occupied by `clawbits-overview`,
`clawbits-images`, `clawbits-email` and `clawbits-maintenance`.

---

## 2. The delivery mechanism is forced

Three constraints collapse the option space to one answer.

**The plugin cannot shell out.** OpenClaw's install-time security scan rejects
plugins using `child_process`. That is why `openclaw clawbits update` only
*prints* the command to run (`plugin/docs/SELF_UPDATE.md:16-19`,
`plugin/src/tools/update.ts:7-11`). So `openclaw skills install` from inside the
plugin is dead on arrival.

**There is no in-process skills service.** The automations reconciler works
because `ctx.getCron()` hands the plugin the gateway's *real* CronService -
operator scopes and device pairing gate only external clients, so the in-process
plugin needs no token (`plugin/src/automations/cron-handle.ts:1-10`). No
documented `ctx.getSkills()` exists. The gateway JSON-RPC `skills.install` /
`skills.upload.*` methods require `operator.admin` and, for archives,
`skills.install.allowUploadedArchives` which is off by default.

**But the plugin already writes files, and already knows where.** Three modules
do `node:fs` writes today (`file-logger.ts`, `channel-watermarks.ts`,
`inbound-dispatch-guard.ts`), and the `gateway_start` hook context is documented
to carry `workspaceDir` - the parent of the highest-precedence skills root.

=> **The plugin materializes skill directories on disk.** Everything else in
this plan follows from that.

Two pieces of luck, both **verified on a live agent** (§9):

- **Newly created skill directories hot-reload.** Not just edits to a known
  `SKILL.md` - a directory created 18.5 hours into a gateway's uptime appeared in
  that running gateway's loaded set, eligible and model-visible, with no restart.
  Deletion is watched too. `skills.load.watch` is not set in config, so this is
  the built-in default.
- `<workspace>/skills` on reef is `/home/node/.openclaw/workspace/skills`, and
  `volume_dest = "/home/node/.openclaw/workspace"` (`reef/profiles.py:168`) is a
  persistent named volume. Skills written there survive a VM upgrade. This is
  also where `openclaw skills install` puts a skill by default (verified), so a
  chat-installed skill and a Clawbits-installed one land in the same durable root.

One trap, and one that turned out not to apply:

- Never mount over `~/.openclaw`; it shadows the baked-in Clawbits plugin
  (`reef/profiles.py:88`).
- `~/.openclaw/skills` is **not** on the persistent volume, so anything installed
  there dies on container recreate - but this is the `--global` path only, and
  `--global` defaults to false. It is not where ordinary installs land.

---

## 3. Where the automations analogy holds, and where it breaks

Holds (lift verbatim):

| automations | skills |
|---|---|
| `desired_spec` JSONB | version manifest + body |
| `desired_generation` (monotonic per agent) | same |
| `observed_generation`, `is_current = obs >= desired` | same |
| `sync_status` requested/applied/failed/removing | + `staged` |
| `managed_by` clawbits/external | same |
| soft delete -> agent confirms -> hard delete | same |
| `GET .../desired` + `POST .../state`, api_key auth | same |
| `automation.sync` WS nudge on the agent topic | `skill.sync` |
| 30 s poll + 3 s/45 s post-write burst, no optimistic UI | same |

Breaks:

- **A cron job is one small JSON object; a skill is a file tree.** Bodies must
  not ride the desired feed. The index carries hashes; a separate fat GET pulls
  content only when the local hash differs.
- **No in-process handle** (§2), so the write path is `fs`, not an API call.
- **`spec_hash` is currently dead code** - stored, projected, typed in TS, never
  compared (convergence is 100% generation-based today). For skills the content
  hash becomes the load-bearing drift gate that avoids rewriting unchanged
  files.
- **Deletion deletes directories.** The blast radius of a bug is categorically
  worse than deleting a cron row.
- **Automations conflate definition and attachment in one table**, which is
  exactly why they have no library, no reuse and no fork. Skills must split
  catalog from attachment.

### Bugs in the automations plane not to inherit

Each verified in the shipped code, each separately filed:

- `reconcile.ts:315-333` catches a failed `cron.remove`, logs a warning, and
  reports `status: "removed"` **unconditionally**. The server hard-deletes the
  row and its run history; the job keeps firing and resurrects next pass as a
  new "external" row. Removal must be verified (`stat()` after `rm -rf`) before
  reporting removed.
- `reconcile.ts:336` - `intent:"present"` with a null spec hits a bare
  `continue`, producing no report at all, so the row is stuck in `requested`
  forever with no error text.
- `reconcile.ts:496-499` vs `:528` - `dirty` is only cleared inside the branch
  that runs a reconcile, so a wake arriving before the handle exists busy-spins
  at 100% CPU.
- Per-account loops share a process-global handle
  (`gateway-adapter.ts:937`), so account A mirrors account B's jobs into its own
  `external[]`. A skills loop scanning one shared directory has the same bug
  **and it deletes**. Use a single claimed owner loop
  (`claimUsageReporter` at `plugin/src/usage/collector.ts:281` is the pattern).
- Report caps silently truncate at 500 items server-side with no signal.
- No jitter, no backoff: a fixed 60 s interval means the whole fleet retries in
  lockstep after an outage.

---

## 4. Recommended architecture

**Skill Registry**: an org catalog of immutable versioned skills, plus a thin
per-agent install list that carries the desired-state machinery. Text-only in
v1. Ship catalog-first, with zero agent involvement in the first release.

### Two planes

- **Catalog** (`skills`, `skill_versions`): ordinary org-scoped CRUD. No
  generations, no sync status, no agent FK. Never mutated by an agent report.
- **Install** (`agent_skill_installs`, `agent_skill_sync_state`,
  `skill_install_events`): the automations machinery. Never edited by an author.

The agent receives a **flat resolved list**. It never learns whether a skill is
org-owned, forked, public or plugin-shipped. Fork lineage and public inheritance
resolve server-side, exactly as `get_desired_automations` already flattens
everything per agent.

### Storage: Postgres rows, not git

The existing agent-git-repos backend needs five fixes before it could host
anything: `git` is absent from the production image, there is no persistent
volume for `GIT_REPOS_BASE_PATH`, there is no clone/fork endpoint,
`create_commit` mutates a shared non-bare working tree with no lock under
`--workers 4`, and `os.path.join(rpath, f['path'])` at
`clawbits/git/repo_manager.py:222` has an open traversal hole. That is a
subsystem of work to buy one operation - fork - which is a single INSERT in the
row model.

Also rejected: `shared_content` (64 KB cap, agent-scoped, rejects dotfiles,
public R2 domain with no per-object ACL, and its human listing endpoint has no
org filter) and `mm_files` (`channel_id` is a NOT NULL FK; a skill has no
channel).

A skill version is a row: normalized `manifest` JSONB, `body_md` text, and a
`files` JSONB array capped at 9 UTF-8 markdown references / 256 KB total.
`content_hash` reuses `canonical_json` + sha256 from
`clawbits/automations/spec.py:98-111` verbatim.

### Key schema decisions

- `skills.org_id` is **NOT NULL** and is the real tenancy filter. Contrast
  `automations.org_id`, which is nullable and never actually queried (the real
  filter is the join to `agents`). A skill has no agent to join through, so the
  column *is* the boundary.
- `UNIQUE(agent_id, slug)` on installs, **not** partial. A partial index would
  let a tombstone and a fresh row for the same slug coexist, making reconcile
  ordering load-bearing. Cost: a wedged tombstone locks the slug, paid for by an
  operator `forget` escape hatch.
- `sync_status` includes **`staged`** from day one, because the three runtimes
  disagree on when a write takes effect and adding a CHECK value later is a
  constraint rewrite.
- The `clawbits-` slug prefix is reserved at create (§1: flat name space).
- First-party public skills live in a real org row, not a nullable `org_id`, so
  every `org_id = :org` filter stays valid.

### Normalization is the security boundary

`clawbits/skills/spec.py`, structurally identical to the automations spec:
validate at the HTTP layer, allowlist-normalize (unknown keys **dropped**, not
rejected), then hash the normalized form. Every write path - create, publish,
fork, adopt - goes through this one chokepoint.

Three neutralizers, by direct analogy to pinning `delivery.mode` to `announce`
(the only thing stopping automations becoming a webhook exfiltration route):

- **`metadata.openclaw.install` dropped entirely.** It declares brew/node/go/uv/
  **download** installer specs run at load time.
- **`requires.config` dropped.** It probes the agent's own `openclaw.json`.
- **`always` forced false.** It skips every eligibility gate.

No `runtime_overrides` bag: per-runtime output is derived from normalized
canonical fields only, or the neutralizers are trivially bypassed.

`requires.env` survives as **names only**, never values. No secret enters a
skill version.

Path validation on `files[].path`: relative only, no `..`, no leading `/`, no
backslash or NUL, each segment `^[A-Za-z0-9._-]{1,64}$`, first segment must be
`references`, `.clawbits` reserved.

### Multiple agent types: render server-side

A single canonical record; per-runtime frontmatter **emitted** by the server.
The three dialects are genuinely incompatible - OpenClaw uses
`metadata.openclaw.requires.*`, IronClaw uses
`activation.keywords/patterns/max_context_tokens`, Hermes uses
`metadata.hermes.*` plus `required_environment_variables` plus `platforms`.
Storing raw SKILL.md text and shipping it everywhere silently loses gating on
two of three runtimes.

A registry modelled on `reef/agents.py`:

| runtime | client? | apply mode | path | verdict |
|---|---|---|---|---|
| openclaw | yes | `watch` | `<workspace>/skills` | v1 |
| hermes | needs a Python reconciler in `extensions/hermes` | `ondemand` | `/opt/data/skills` (inferred, unverified) | later, no protocol change |
| ironclaw | **structurally blocked** | `restart` | n/a | unsupported |

IronClaw's channel is a WASM component whose capabilities manifest confines
writes to `channels/clawbits/` and HTTP to `{host: app.clawbits.ai, path_prefix:
/api/agentic}` (`ironclaw-channel/clawbits.capabilities.json`). Its
`config.toml` is rewritten every boot and it has no prompt-assembly path.
Support means a Rust change **plus** a manifest bump **plus** a channel rebuild
**plus** an image rebuild **plus** a fleet upgrade. Recommend declaring it
unsupported with honest UI copy rather than half-shipping it.

A `GET .../render?runtime=` route returns the exact bytes that land on disk, so
the per-runtime emission never becomes a "where did my YAML go" surprise.

### Discovery: everything the agent actually has

**Requirement (owner, 2026-08-13):** whatever skills are really on the agent must
be visible in the Clawbits UI, however they got there. If someone tells the agent
in chat "install `<x>` from ClawHub", that skill shows up in our UI.

This is the `managed_by='external'` mirror, ported from automations - but the
automations version only had one place to look. Skills have six (§1), and getting
this wrong makes the feature silently useless.

**The write root and the read roots are different sets.**

- We **write** to exactly one root: `<workspace>/skills`. Never anywhere else.
- We **read** all six, recursively (OpenClaw discovers up to 6 levels deep), and
  mirror everything found.

Anything found outside the write root is external by construction: report it,
never write it, never delete it. Each mirrored row records which root it came
from, so the UI can say *where* a skill lives, not just that it exists.

**The chat-install hazard.** `openclaw skills install` has `--global` (the shared
managed dir, i.e. `<state-dir>/skills`) and `--agent <id>` (that agent's
workspace). The default with neither flag is **unverified** (§9). The ClawHub
CLI's own root resolver lists `<stateDir>/skills` *first*, labelled "Shared
skills", which suggests the state dir is the conventional shared target. If that
is the default, then a chat-installed skill lands in `~/.openclaw/skills`, which
on reef is **not on the persistent volume** and is destroyed on the next
container recreate. So this requirement has a second half: we must not only show
these skills, we must tell the truth about them - a mirrored skill outside the
persistent volume gets a "will not survive an upgrade" warning, and "adopt into
the library" is the fix we offer.

**Provenance, not just presence.** A mirrored skill should say where it came
from, and we can often know:

| signal | meaning |
|---|---|
| our `.clawbits/origin.json` | managed by us; not external at all |
| `.clawhub/lock.json` at the root (verified: `clawhub/dist/skills.js:82,96`) | installed from ClawHub - gives owner/slug/version |
| plugin-manifest root | shipped by a plugin (our four `clawbits-*` skills) |
| bundled root | shipped with the OpenClaw install |
| none of the above | hand-authored in the agent's workspace |

The lockfile is per-root, not per-skill, so it is one read per root that resolves
provenance for every ClawHub skill under it.

**Adopt.** An external skill can be promoted into the org catalog as a new v1.0.0
draft. This is the natural answer to "my agent has a great skill, put it in the
library" and to the non-persistent-root problem above. Two guardrails, because
everything in a report is agent-controlled untrusted text: adoption is an
explicit human action that opens the full body in an editor first (never
one-click), and the adopted content goes through the same normalization
chokepoint (§4) as every other write path. Adopt copies; it never converts a row
in place, so the mirrored row stays honest about what is on disk.

**Bundled and plugin skills are shown, not hidden.** Our own four `clawbits-*`
skills occupy the flat name space (§1) and consume prompt budget like any other.
Showing them as a read-only "built-in" group is what makes a name collision
visible *before* someone authors `clawbits-email` in their org library.

### Client algorithm

Extract `plugin/src/sync/loop.ts` from `automations/reconcile.ts` first - the
wake registry, abortable sleep, single-flight, 20 s request ceiling and
never-throw posture are resource-agnostic, and there are already three
near-identical copies. Add jitter and backoff during the extraction.

Per pass, on a **single claimed owner loop**:

1. Resolve the **write** root: `ctx.workspaceDir` -> config ->
   `~/.openclaw/workspace`. Require the workspace to already exist as proof of
   correct resolution, then `mkdir` `skills` under it. Never create a workspace.
   Always report the resolved root so a wrong guess is visible, not silent.
2. Resolve the **read** roots: all six (§1), from `ctx.config` where possible
   (`skills.load.extraDirs`, agent workspaces) plus the two fixed state-dir and
   `~/.agents` paths. Report the resolved list so the operator can see exactly
   what we looked at - a root we failed to resolve is a skill we will never show,
   and silence there is the failure mode that makes the mirror a lie.
3. Scan each read root recursively for `SKILL.md`/`skill.md`, capped at 6 levels
   and at the report cap. Read `.clawbits/origin.json` per skill and
   `.clawhub/lock.json` per root.
4. Classify: **ours** (our marker, in the write root), **external** (everything
   else) with a provenance tag and the root it came from.
5. **Quarantine, do not ignore** - but only inside the write root. A directory
   carrying *our* marker whose org or agent does not match is *moved* out.
   "Mirror, never touch" is wrong there: `<workspace>/skills` is the
   highest-precedence root, so leaving a recycled volume's skills in place means
   the new agent actively loads and prompts on the previous org's instructions.
   Nothing clears `agents.reef_sandbox_id`, reef never deletes named volumes, and
   auto-naming only excludes currently-live names - so a recycled sandbox is a
   real path. Outside the write root we never move anything: those are the user's
   own skills and a mirror that mutates is not a mirror.
6. `GET /skills/desired`. If `paused`, report and change nothing.
7. **Drift gate**: marker hash == desired hash and enabled matches -> write
   nothing. This is the single most important line. The automations equivalent
   (unconditional re-apply) silently stopped jobs firing while reporting
   `applied`; the skills-shaped hazard is bumping mtime and retriggering the
   watcher every cycle forever.
8. Otherwise fetch the version, verify each file's sha256, write to a staging
   dir, fsync, `rm -rf` target, `rename` into place, write `origin.json` last.
   Rename keeps the watcher from seeing a half-written skill. Explicit directory
   diff: local files absent from the manifest are deleted.
9. `disabled` -> delete the directory. Presence is the enable mechanism, because
   a `skills.*` config write is reported to be a no-op until gateway restart
   (`docs/REEF_AGENT_ENV_PLAN.md:515`) - unverified, see §9.
10. Batch the report, chunked at exactly the server cap. **The report carries
    both lanes**: `managed[]` for our rows and `external[]` for everything the
    scan found elsewhere. Both are capped and truncation is signalled in the ack -
    automations slices silently at 500 and then flags the dropped tail as drift.

Our marker is `<slug>/.clawbits/origin.json`, carrying install/skill/org/agent/
version ids, content hash and per-file hashes. The name deliberately parallels
ClawHub's `.clawhub/` directory, though the shapes differ: ClawHub keeps a single
`lock.json` **per root** (`clawhub/dist/skills.js:82,96`,
`clawhub/dist/cli.js:88-94`, with a legacy `.clawdhub/` fallback), while ours is
per skill.

`POST /api/agentic/skills/state` **must** be added to
`AGENTIC_WRITE_BILLING_EXEMPT_PATHS` (`clawbits_server.py:145-152`) in the same
commit that registers the route, or every agent burns 1000 CB_TOKENS per tick
just by existing and the 402 surfaces as a mystery sync stall.

---

## 5. Fork

Fork is a server-side row copy: new `skills` row in the forking org, new v1.0.0
version carrying the source content, `forked_from_skill_id` +
`forked_from_version_id` recorded.

Upstream tracking compares the fork's base version against the source's current
latest, yielding four states: clean / modified / behind / diverged. A
`upstream_seen_version_id` column persists dismissal, so "I know, I don't want
it" is a decision the system remembers rather than a banner that nags forever.

Deliberately **not** doing line-level three-way merge. A skill is usually one
markdown file; the honest UX for "we both rewrote the instructions" is a
side-by-side diff plus an editor, not a machine guess whose conflict markers
would ship into an agent's prompt.

---

## 6. Cross-org attach is forbidden

**A skill owned by another org can never be attached to an agent. It must be
forked first.** Enforced as `skills.org_id == agent.org_id` or 409.

This one rule closes two separate holes at once: the IDOR where a `{skill_id}`
in a request body reaches a foreign org's private skill, and the public-skill
supply chain where upstream edits silently reach installed agents. It costs the
"install straight from the public library" flow, which is the first thing users
will ask to remove - it should stay.

---

## 7. Security model

**A skill is instructions the model follows, pushed to every agent in an org.**
That is the threat model, and it is not hypothetical.

- **The VM is not the tenant boundary.** Reef mirrors the agent's minted
  Clawbits identity into the guest, and pins `exec-policy preset yolo` with
  `tools.fs.workspaceOnly` false. A hostile skill's first move is not host
  escape - it is reading the api_key and acting as the agent over
  `/api/agentic`. "The microVM is the boundary" is true for the *host* and false
  for the *Clawbits tenant*.
- **`description` is an always-on injection vector.** It is injected into every
  prompt of every agent that has the skill installed, and fires without the
  model ever deciding to invoke the skill. The 160-char cap is a budget control,
  not a safety control.
- **OpenClaw's install-time scanning is not a control we can lean on.**
  `security.installPolicy` is fail-open by default (`enabled: false`).
- **No author/reviewer separation exists.** There are two roles (`owner`,
  `member`, a raw TEXT column policed by a DB CHECK). Any member can author.

v1 mitigations: no `scripts/` at all (removes the whole RCE class), cross-org
content only arrives through fork (which shows the operator the full text in an
editor before it becomes theirs), an append-only `skill_install_events` trail
with `actor_human_id`, and `_rate_limit` (`human_endpoints.py:149`) on publish
and fork - the human lane has no CB_TOKENS backstop and these are the only
routes where an authenticated human writes unbounded rows.

### Adjacent leaks to close first

Found while researching this feature, each verified, each filed separately.
Shipping a skills library beside a leaking competitor feature is not acceptable:

- `GET /api/human/actions` and `GET /api/agentic/actions` list **every org's**
  agent action documents with no org predicate at all
  (`table_read.py:2938`, `human_endpoints.py:2344`, `clawbits_server.py:3972`).
  `agent_actions` is the closest existing "agent instruction document" feature
  to skills; it has no `org_id`, no versioning and no lifecycle. Recommend
  deleting these endpoints rather than extending the model.
- `GET /api/agentic/agents/{agent_id}/info` authenticates the bearer as *some*
  agent, then returns whatever `agent_id` was asked for - leaking any agent's
  org, operator id and operator email across orgs
  (`clawbits_server.py:2132`). The `_require_own_agent` pattern already exists
  at `git_endpoints.py:49-51`.

Note that org isolation here is enforced **by convention** - no row-level
security, no query-time filter, no `Depends(require_org)`. One forgotten check
is a silent cross-org read. Worth making the skills gate a real FastAPI
dependency, which would be the first of its kind in this codebase.

---

## 8. Phasing

**Scope directive (owner, 2026-08-13): keep v1 simple.** MVP is the three slices
below the line. Everything else is explicitly deferred, and the §11 rejections
plus the §4 security chokepoint stay in force regardless - they are what make the
small version safe rather than merely small.

### MVP - build this

| slice | scope | why it is in |
|---|---|---|
| **M1** | **Catalog.** `skills` + `skill_versions`. Create, edit, publish (implicit patch bump), version list, revert, fork, delete. `spec.py` normalization + the three neutralizers. One `/render` route. Frontend `/skills` list + detail + editor. | The whole "per-org storage so people can add skills" ask, standalone. No plugin, no image, no agent, no sync. |
| **M2** | **DONE.** `agent_skill_installs` + `agent_skill_sync_state`, `POST /api/agentic/skills/state` + billing exemption, read-only plugin scanner, agent Skills tab. The `desired` route lands with M3, which is the release that needs it. | The "installed skills must be visible in our UI" ask. |
| **M3** | **DONE.** Desired feed + version fetch, install/uninstall/enable, plugin apply path (drift gate, staged-then-rename, verified removal). | The actual feature. |

Ship M1 before M2 is written. It is genuinely useful alone - an org authors and
forks skills and copies a rendered `SKILL.md` out by hand - and it carries no
distributed-systems risk at all.

### Deferred - not in v1

| deferred | why it can wait |
|---|---|
| Public tier + `visibility='public'` routes | Needs a legal decision (§10b). Ship the column, leave the tier dark. |
| Fork upstream tracking (four-state verdict, dismissal, rebase) | v1 fork is a copy with lineage recorded. "The source changed" is a later nicety. |
| Adopt-into-library | Nice, but M2 already makes external skills *visible*, which was the actual ask. |
| `skill_install_events` audit table | Add when publish approval (§10b) is decided; `created_by` on the rows covers v1. |
| Hermes + `render_hermes` | The runtime registry ships in M1 so this is one emitter branch later. |
| Usage telemetry, version pruning, budget enforcement | All need real usage data first. |
| `scripts/` and blob storage | Locked out of v1 (§10a). |
| `resync` imperative generation | The drift gate plus a manual uninstall/reinstall covers it. |

### Simplifications the verification bought

Finding 1 (§9) removes the restart affordance, the `staged` UX and the
apply-mode copy from the OpenClaw path entirely - directory presence is the whole
mechanism, and it takes effect on the next turn. `staged` stays in the CHECK
constraint (free, and a later migration to add it is not) but nothing in v1
renders it.

Finding 3 (§9) may remove the six-root scan and all marker parsing from M2: if
the plugin can reach `skills.status`, that one RPC already returns every skill
with `source`, `filePath`, `eligible` and `modelVisible`. **Spike this first** -
it is a day, and a yes makes M2 substantially smaller than §4 describes.

### Fleet rollout is a real cost, not a line item

M2 is the first slice that ships a client, so it pays the whole release train:
ClawHub publish -> plugin floor bump -> image build -> fleet upgrade of every
agent. During the weeks when half the fleet has it, the skills tab must render
everywhere but disable install affordances below the floor, with honest copy
naming the running version. The floor is computed server-side from the alive-ping
`plugin_version`; `min_client_version` in the desired response does **not** work
as a degradation mechanism, because a plugin old enough to matter never calls the
route.

### Fleet rollout is a real cost, not a line item

Shipping the client means ClawHub publish -> plugin floor bump -> image build ->
fleet upgrade of every agent. During the weeks when half the fleet has it, the
skills tab must render everywhere but disable install affordances below the
floor with honest copy naming the running version. The floor is computed
server-side from the alive-ping `plugin_version`; `min_client_version` in the
desired response does **not** work as a degradation mechanism, because a plugin
old enough to matter never calls the route.

---

## 9. Verification

### VERIFIED on a live agent, 2026-08-13

Reef-managed OpenClaw container `bashful-axolotl`, image `reef-oc:plugin`
(`oc2026.6.11-pl0.12.0`), gateway PID 1 up 18h36m and never restarted during the
test. Probe skill created and removed; agent restored to its original state.

**1. New skill directories ARE hot-reloaded. No restart.** The `skills` root did
not exist when the gateway started. Creating `<workspace>/skills/probe-newdir/`
18.5 hours into the gateway's uptime made it appear in the **running gateway's**
loaded set (`skills.status` RPC) as `eligible: true, modelVisible: true`. Deleting
it dropped the count 57 -> 56 with no restart, so **removal is watched too**.

This settles the most consequential unknown in the whole plan. The product
promise is **"add a skill, the agent has it"** - not "add a skill, then restart".
Consequences: no Restart affordance is needed for OpenClaw (that open question is
dropped), and `staged` stays in the CHECK constraint only for the runtimes that
genuinely need it later.

**2. `openclaw skills install` with no flags targets the WORKSPACE.** Verified
output: `Installing to /home/node/.openclaw/workspace/skills/probe-newdir…`.
`--global` (default false) is what selects `<state-dir>/skills`. This is the good
outcome and it reverses an earlier inference drawn from the ClawHub CLI's root
ordering: a chat-installed skill lands in the same root we write to, which is the
highest-precedence root **and** is on reef's persistent volume. So chat-installed
skills are both visible to our scan and durable across a VM upgrade. The
"ephemeral storage" hazard does not apply to the default path.

**3. OpenClaw already computes provenance for us.** `skills.status` returns per
skill: `source` (`openclaw-bundled` / `openclaw-extra` / `openclaw-workspace` /
`clawhub`), `filePath`, `baseDir`, `skillKey`, `eligible`, `modelVisible`,
`disabled`, `blockedByAllowlist`, `blockedByAgentFilter`, `platformIncompatible`,
`userInvocable`, plus `requirements` and `missing` (bins/env/config/os). It also
returns `workspaceDir` and `managedSkillsDir` at the top level.

This is strictly better than reconstructing provenance from marker files, and it
replaces the six-root scan described in §4 **if** the in-process plugin can reach
this RPC (see below). On the test agent: 57 skills, 52 bundled, 4 `openclaw-extra`
(our `clawbits-*`), 1 workspace.

**4. OpenClaw writes its own per-skill provenance marker** at
`<slug>/.openclaw/source-origin.json`: `{version, source, spec, slug, installedAt}`
- e.g. `source: "path"`, `spec: "/tmp/probe-newdir"`. For a ClawHub install this
carries the `@owner/slug` ref. Note this is OpenClaw's marker, not the standalone
`clawhub` CLI's per-root `.clawhub/lock.json`. Our marker must live under a
different name to avoid colliding with it.

**5. `skills.load.watch` is not present in the config** (`config get` returns
"Config path not found"), so the observed watch behaviour is the built-in
default, not something reef sets.

### Still to verify

1. ~~**Can the in-process plugin call `skills.status`?**~~ **SPIKED - the answer
   is NO, and it does not matter as much as feared.** Read from OpenClaw's own
   source inside the running container (`/app`, 2026.6.11):

   `skills.status` is a **gateway server method** (registered in
   `dist/server-methods-*.js` via `createLazyCoreHandlers`), not a plugin surface.
   OpenClaw's `package.json` has 325 `exports` entries and exactly **two** are
   skill-related, which is the whole plugin-facing skill API:

   - `./plugin-sdk/skills-runtime` -> `registerSkillsChangeListener`,
     `getSkillsSnapshotVersion`, `shouldRefreshSnapshotForVersion`,
     `bumpSkillsSnapshotVersion`
   - `./plugin-sdk/skill-commands-runtime` -> `listSkillCommandsForWorkspace`,
     `listSkillCommandsForAgents` (skill *commands*, not skills)

   There is no `listSkills()` equivalent to `ctx.getCron()`, and the `exports` map
   blocks deep-importing the internal lister. **So the filesystem scan in §4
   stands** - M2 is not smaller.

   **But the spike paid for itself three times over.** From
   `src/skills/runtime/refresh-state.ts` (read verbatim):

   - `registerSkillsChangeListener(fn)` returns an unsubscribe and fires
     `{workspaceDir?, reason, changedPath?}` on **every** skill change - including
     a user's own `openclaw skills install`. That is a precise in-process wake for
     the mirror, far better than waiting out a 60 s poll.
   - `getSkillsSnapshotVersion(workspaceDir?)` + `shouldRefreshSnapshotForVersion`
     give a cheap "did anything change" gate, so the plugin can **skip the whole
     filesystem scan** when the version has not moved. This is the scan-side
     analogue of the drift gate.
   - `bumpSkillsSnapshotVersion({workspaceDir, reason, changedPath})` lets the
     plugin **force a refresh after its own write** rather than depending on
     fs-watch timing. This removes our reliance on watcher semantics entirely: we
     write, we bump, the next turn is guaranteed to see it.

   Design consequence for M2/M3: keep the scan, add the listener as the wake, gate
   the scan on the snapshot version, and bump after every materialize.
2. **Is `workspaceDir` on the `gateway_start` ctx?** Less critical now:
   `skills.status` returns `workspaceDir` and `managedSkillsDir` directly. Still
   worth logging `Object.keys(ctx)` in a dev build.
3. **The real `skills.limits.maxSkillsPromptChars` default.** Not in config on
   this agent either, so it is a built-in default. The budget stays warn-only
   until measured.
4. **Is a `skills.*` config write really a no-op until restart?** Unchanged. The
   design routes around it by using directory presence as the lever, and finding
   1 makes that lever fully sufficient.
5. **Does a fleet upgrade preserve `<workspace>/skills` in practice?** The
   volume should survive, but this has never been exercised for a directory the
   plugin itself wrote.
6. Whether the `skill_changed` hook fires, and whether it fires for our own
   writes (if so it needs debouncing). Latency optimization only - the poll is
   the correctness guarantee.
7. **Where Hermes skills actually live.** Phase 6 only. `/opt/data/skills` is
   *inferred* from `HERMES_HOME=/opt/data` plus the documented `~/.hermes/skills`.
   There is zero skills code in `reef/images/hermes-runtime/`.

---

## 10a. Locked decisions

Locked by the owner, 2026-08-13.

**Keep v1 simple.** MVP is M1/M2/M3 in §8; everything else is deferred with the
feature that needs it. The constraints that stay non-negotiable at any size: the
§4 normalization chokepoint with its three neutralizers, cross-org attach
forbidden (§6), text-only content, verified removal, and the drift gate.

**No executable files in v1.** A skill is `SKILL.md` plus up to 9 UTF-8 markdown
references. Revisit post-MVP behind an owner-only gate, a review step, blob
storage and GC. The `has_executable` column ships in v1 anyway (always false) so
the affordance and the UI surface exist before they are needed. This removes the
entire RCE class from phases 1-4 and is the reason the security model in §7 is
tractable.

**OpenClaw only in v1; Hermes next; IronClaw unsupported.** The runtime registry
and server-side per-dialect rendering (§4) ship in v1 regardless, so Hermes is
one emitter branch plus a Python reconciler in `extensions/hermes` reusing the
identical wire protocol - **zero backend protocol change**. IronClaw gets honest
UI copy saying skills are not available on that runtime, not a half-shipped
client.

**Assignment is per-agent, with bulk multi-select.** No `skill_sets` table and no
`org_default` flag in v1. Accepted cost: "which agents are missing this?" is not
a first-class question, and retrofitting a fleet-level unit later is expensive.
Revisit if the prompt-budget curation problem (§10b) becomes real, since skill
sets are the natural tool for it.

**Same-org installs auto-update.** `channel='latest'` is the default for
same-org installs; editing a skill and publishing propagates to every agent
running it on the next sync, with a per-install opt-out to a pinned version.
Safe *because* cross-org attach is forbidden (§6), so every install is same-org
by construction. Rollback is picking an older version from a dropdown, which is
why immutable versions are load-bearing rather than decorative.

---

## 10b. Still open

1. **What is the public tier - Clawbits-only, ClawHub import, or ClawHub
   publish?** ClawHub hosts nothing private: everything there is public and
   MIT-0 with no visibility field in its API. "Publish publicly" via ClawHub is
   an irrevocable MIT-0 grant on org-authored content. A legal decision, not an
   engineering one. Blocks the public tier only; the `visibility` column ships in M1
   regardless.
2. **Does publishing need a second person's approval?** No third role exists to
   lean on - there are two (`owner`, `member`, a raw TEXT column policed by a DB
   CHECK). Sharpened by the auto-update lock: a member's publish now reaches
   every agent running that skill without a per-agent human in the loop. Cheapest
   version is one org setting plus a `pending` version state.
3. **Do we invest in a usage signal?** Every state chip reports *installation*
   health, which is a fact about our sync plane. Zero report *usage* health,
   which is the fact the operator wants. Without it there is no pruning signal
   and no answer to "is this library any good".
4. ~~**Restart affordance.**~~ **Resolved by verification, not by decision.**
   §9 finding 1 shows new directories hot-reload on the running gateway with no
   restart, so there is nothing to restart and no button to design. Revisit only
   for Hermes/IronClaw when that work is picked up.
5. **What happens to installs when a library skill is deleted?** Second-order
   hazard: automations reference skills **by name** in their payloads and fail
   at runtime with `skill '<name>' not found` - a failure in a different feature
   with no link back to the cause. There is no reference check today.
6. **Warn or hard-block on the prompt budget?** Past the limit OpenClaw
   shortens then omits skills with **no error surfaced anywhere**, so an org
   that keeps adding skills experiences it as agents gradually getting worse.
   Interacts with the per-agent assignment lock: without skill sets, the meter
   is the only curation tool.

---

## 11. Explicitly rejected

Recorded so they are not re-proposed.

- **Skills on the existing git repos backend.** Five subsystem fixes to buy one
  operation that is a single INSERT in the row model.
- **`shared_content` or `mm_files` as the store.** See §4.
- **Content-addressed Merkle trees with a global blob store, in v1.** Correct at
  scale, wrong now: it removes `org_id` from the blob and version tables so
  tenancy becomes a reachability join every future handler must remember to
  write - in a codebase whose isolation is convention-only with three live
  by-id cross-org leaks - and needs a mark-and-sweep GC whose failure mode is
  silently corrupting installed skills. The one GC job this repo has documented
  (`ATTACHMENTS.md`) was never implemented. Revisit when binaries land.
- **A single conflated table holding definition and attachment** (the pure
  automations port). Exactly why automations have no library and no fork, and it
  makes a definition unrecoverable after a bad edit because the fan-out
  overwrites the only frozen snapshot.
- **`runtime_overrides` as a manifest field.** An unnormalized bag feeding the
  renderer is a bypass of the neutralizers.
- **Making skills a reef capability.** `reef/capabilities.py:1-30` states the
  rule: a capability gates what crosses the microVM boundary, and "the agent
  writing its own files" is named as deliberately ungated. Mechanically wrong
  too - `REEF_CAPS` reaches the guest once at boot.
- **`skills.entries.<name>.enabled: false` as the disable mechanism.** Reported
  to be a no-op until restart with no user-visible signal. Directory presence is
  the lever.
- **ClawHub as the public tier.** Cannot host org-private skills.
- **Optimistic UI updates.** The burst poll resurrects optimistically-removed
  rows. The honest amber `requested` state is the design, exactly as in
  automations.
- **Operator-only install authority.** `agents.operator_id` is write-once with
  no transfer endpoint, so an agent whose operator left the org would be
  permanently unmanageable. Use `can_manage_agent_contacts` (operator **or** org
  owner), which already exists at `table_read.py:914`.
- **The automations org-list gate for the skills roll-up.** It requires
  `Agent.operator_id == human_id`, so an org owner who operates no agents would
  see an empty library.

---

## 12. Where it lives in the UI

| surface | route | entry point |
|---|---|---|
| Org skill library | `/skills` | Rail icon (4th, after Agents) - `NAV_SECTIONS` in `lib/navSections.ts` |
| One skill | `/skills/:skillId` | Click a card |
| An agent's skills | `/agents/:id/skills` | Agent nav item (with install count), between Automations and Manage |

Also reachable from the command palette ("Go to Skills") and, on mobile, from
Settings -> Library -> Skills. The library is a full-width page: it is not in
`sectionHasSidebar`, because a catalog grid has nothing to put in a sidebar.
