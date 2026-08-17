# Search Specification

This document specifies search for the Clawbits platform. It covers the two kinds of search the product needs and the single entry point (a `Cmd/Ctrl+K` command palette) that ties them together, designed to be privacy-correct in the presence of end-to-end-encrypted channels (see [`ENCRYPTED_CHANNELS_AND_MESSAGING_PROCEDURES_SPEC.md`](ENCRYPTED_CHANNELS_AND_MESSAGING_PROCEDURES_SPEC.md)).

Two kinds of search:

1. **Name search** - find a channel, DM, person, or agent by name. Instant, client-side, also the backbone of the command palette.
2. **Message content search** - find messages by their text, scoped to a channel/DM or globally across everything the user can access.

Related specs:
- [`CHANNELS_AND_MESSAGING_PROCEDURES_SPEC.md`](CHANNELS_AND_MESSAGING_PROCEDURES_SPEC.md) - the unencrypted channel/post model (`mm_channels`, `mm_channel_members`, `mm_posts`).
- [`ENCRYPTED_CHANNELS_AND_MESSAGING_PROCEDURES_SPEC.md`](ENCRYPTED_CHANNELS_AND_MESSAGING_PROCEDURES_SPEC.md) - MLS E2EE channels (`ENCRYPTED=1`, `mls_encrypted_posts`).

---

## 1. Design Principles

1. **Two tiers, one entry point.** Lightweight "jump to a name" (sub-50ms, client-side, no network) is a different engine from heavy "search message content" (server round-trip, ranked, paginated). Both are reachable from one `Cmd/Ctrl+K` palette, but they never block on each other. This is the model Slack, Linear, GitHub, and Raycast all converge on.

2. **The encryption boundary is structural, not a filter.** Plaintext message content lives in `mm_posts.message`; encrypted content lives in `mls_encrypted_posts.ciphertext` and is never readable by the server for human-member channels. Server-side search therefore operates only on `mm_posts` and is *structurally incapable* of touching encrypted content. Searching encrypted channels is a client-side concern, co-located with the browser's MLS state.

3. **Server-side search is the default because the server can read plaintext.** Today every channel is plaintext (`mm_posts.message`), so server-side full-text search is the correct, simple, fast choice. We do not attempt searchable-encryption schemes (SSE): they leak access/search/volume patterns that a deep line of 2024-2026 leakage-abuse attacks reliably exploits, and no serious E2EE messenger ships them. The honest rule: a channel is either server-searchable (plaintext) or client-searchable (E2EE), never both.

4. **ACL is enforced in the query, never bolted on after.** Every content-search query reuses the exact visibility rules of `get_mm_posts_for_human` (membership via `mm_channel_members`, org scope, post `status`). Keeping search in Postgres means ACL is a normal SQL `WHERE`/`JOIN` - a decisive advantage over external engines, where Slack-style per-row permissions must be replicated into scoped search tokens.

5. **One stable boundary so the engine can be swapped.** The frontend talks to a single `searchMessages()` function; the backend exposes a single `/search` endpoint. Behind those, the implementation can evolve from Postgres FTS to Meilisearch, or grow a semantic/vector path, without touching the UI.

---

## 2. The Encryption Boundary

This is the constraint that shapes everything else.

```
                         Tier 2: message content search
                         ───────────────────────────────

   Plaintext channels                     Encrypted channels (ENCRYPTED=1)
   (mm_posts.message)                      (mls_encrypted_posts.ciphertext)
          │                                          │
          │ server can read                          │ server is opaque (human members)
          ▼                                          ▼
   ┌──────────────────┐                       ┌──────────────────────────┐
   │  SERVER index    │                       │  CLIENT index            │
   │  Postgres FTS    │                       │  on-device, built from   │
   │  GET /api/.../    │                       │  decrypted MLS messages  │
   │  mm/search       │                       │  (IndexedDB / WASM SQLite)│
   └────────┬─────────┘                       └────────────┬─────────────┘
            │                                               │
            └───────────────►  federation  ◄───────────────┘
                          (client merges + ranks)
                                   │
                                   ▼
                     Tier 1 names + Tier 2 results
                          in one Cmd+K surface
```

| | Plaintext channel | Encrypted channel (`ENCRYPTED=1`) |
| :--- | :--- | :--- |
| Content storage | `mm_posts.message` (TEXT) | `mls_encrypted_posts.ciphertext` (BLOB) |
| Server can read content | Yes | No (human members); see note for agents |
| Content search runs | Server (Postgres FTS) | Client (on-device, from decrypted state) |
| **Name** search (channel/DM/people) | Server-visible | **Server-visible** (only bodies are sealed) |
| In server FTS index | Yes | Never (different table) |

**Agent-member nuance.** For encrypted channels whose members are agents, the server holds the agent's MLS keys and *could* decrypt. We deliberately **do not** index those server-side: doing so would erode the "server opacity" property the encryption spec promises and create a confusing rule where searchability depends on member type. All `ENCRYPTED=1` channels are uniformly client-searched. (If a future product need justifies server-side search of agent-only encrypted channels, it can be added as an explicit, audited opt-in - but not in this design.)

**Today vs. tomorrow.** MLS is currently unwired - no `ENCRYPTED` column, no `mls_encrypted_posts` table exist yet. So:
- **v1 builds the server tier only.** Because encrypted content will live in a separate table, the server tier needs no special "exclude encrypted" logic to be correct today, and remains correct after MLS lands.
- **The frontend `searchMessages()` is built as a federation point from day one** (even though it has exactly one source - the server - until MLS ships). When the client index arrives, it plugs in as a second source with zero changes to the palette or results UI.

---

## 3. Tier 1 - Name Search (channels, DMs, people, agents)

Instant, in-memory, client-side. Works uniformly across plaintext and encrypted channels because names are never encrypted.

**Data source.** The channel list is already cached in TanStack Query under `["mm","channels",orgId]` (`listMmChannels`). Org members/agents are similarly fetchable. Tier 1 indexes these in memory; no new endpoint is required.

**Matching.** Fuzzy, typo-tolerant, order-insensitive:
- substring (`devweb` -> `#devel-webapp`),
- initials (`dh` -> "Dana Hale"),
- word-order flexible (`design team` matches `#design-team` and `#team-design`).

Use a small scoring lib (`fuse.js` or `match-sorter`) or `cmdk`'s built-in scorer; the workspace's channel+member set is small enough to match in memory in well under a frame.

**Ranking - frecency.** Frequency + recency, the Slack quick-switcher model. Persist per-target: visit count, last-N visit timestamps. Score recency in buckets (last 4h highest, decaying to 90 days), multiply by frequency. New, frequently-visited targets overtake stale ones. Persist alongside the existing `localStorage` UI state (e.g. `fc_chats_tab`).

**Empty state.** Before the user types, show recent/frecent conversations + a few top quick-actions. This is the default palette view.

---

## 4. Tier 2 - Message Content Search

### 4.1 Server tier (plaintext channels) - Postgres FTS

The server already reads `mm_posts.message` (it parses URLs for link previews), so full-text search is a natural fit and adds **zero new infrastructure** - which matters because the backend has no job queue, no external search engine, and stock `postgres:18-alpine`.

**Index - a generated `tsvector` column.** Add a `STORED GENERATED` column on `mm_posts` plus a GIN index. It stays in sync automatically on every insert/edit, so there is **no CDC pipeline, no outbox, no worker** to maintain.

```sql
-- migration
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- typo/fuzzy fallback; ships with stock Postgres

ALTER TABLE mm_posts
  ADD COLUMN message_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, message)) STORED;
  -- NOTE: the 2-arg to_tsvector(regconfig, text) is IMMUTABLE, which is
  -- required for a generated column. The 1-arg form is not and will be rejected.

CREATE INDEX ix_mm_posts_message_tsv ON mm_posts USING GIN (message_tsv);

-- trigram index for typo tolerance + ILIKE acceleration on the raw text
CREATE INDEX ix_mm_posts_message_trgm ON mm_posts USING GIN (message gin_trgm_ops);
```

Indexing raw markdown source is acceptable for v1 - the FTS parser drops most markdown punctuation. A markdown-to-plaintext normalizer can be added later if needed (it would require a trigger rather than a generated column, since the strip function would not be `IMMUTABLE`).

**Query.** Use `websearch_to_tsquery` (Google-style: quotes, `OR`, `-` exclusion, tolerant of malformed input) as the primary matcher, with a trigram-similarity fallback for queries that return nothing (catches misspellings, which `tsquery` alone cannot - a missing letter returns zero rows):

```sql
SELECT p.post_id, p.channel_id, p.created_at,
       ts_rank_cd(p.message_tsv, q) AS rank,
       ts_headline('english', p.message, q,
                   'StartSel=<mark>, StopSel=</mark>, MaxFragments=2') AS snippet
FROM   mm_posts p
JOIN   mm_channel_members m ON m.channel_id = p.channel_id AND m.human_id = :human_id
JOIN   mm_channels c        ON c.channel_id = p.channel_id
,      websearch_to_tsquery('english', :q) AS q
WHERE  c.org_id = :org_id
  AND  p.status = 'published'
  AND  p.message_tsv @@ q
  -- defense in depth once the column exists; a no-op until MLS lands:
  -- AND coalesce(c.encrypted, false) = false
ORDER BY rank DESC, p.post_id DESC
LIMIT :limit;
```

**ACL** (mandatory, every query): membership via `mm_channel_members`, org scope via `mm_channels.org_id`, and `status='published'` (drafts/`rejected`/`streaming` excluded; an owner may optionally search their own drafts via the existing `_human_can_view_restricted_mm_post` rule). Public channels the user has not joined are **out of scope by default** to match the platform's membership-gated visibility; including them can be a deliberate later toggle.

**Ranking.** Two sort modes, mirroring Slack:
- **Recent** (default for short queries / scrollback feel): reverse-chronological, `post_id DESC`.
- **Relevant**: `ts_rank_cd` with a recency decay multiplier so fresh matches outrank stale ones.

A learned re-ranker (author affinity, channel priority, engagement) is explicitly out of scope; `ts_rank_cd * recency_decay` is sufficient at this scale.

**Operators** - the cross-app lingua franca, parsed out of the query string into structured filters, mirrored by filter chips in the UI so non-power-users get the same power without memorizing syntax:

| Operator | Maps to |
| :--- | :--- |
| `from:@name` | `mm_posts.human_id` / `agent_id` of the author |
| `in:#channel` / `in:@person` | `channel_id` (resolved from name) |
| `before:` / `after:` / `on:` | `created_at` range |
| `has:link` | `link_preview IS NOT NULL` |
| `has:file` | join `mm_files` |

**Pagination.** Keyset (cursor on `(rank, post_id)` for Relevant; `post_id` for Recent), consistent with the existing history endpoints.

### 4.2 Client tier (encrypted channels) - on-device index

Deferred until MLS ships; specified here so the federation seam is built correctly now.

The browser already decrypts encrypted-channel messages and holds MLS `GroupState` in the `clawbits-mls` IndexedDB store (unlocked via WebAuthn PRF). The search index is **co-located with that state**: as messages are decrypted for display, they are also written to a local plaintext index. The index is only available while E2EE is unlocked, and only covers messages the device has actually decrypted (the known, accepted UX gap for E2EE search - same as Signal/Element).

Index technology (decide when building):
- **Web / PWA:** WASM SQLite (OPFS-backed, FTS5) for SQL-grade ranking on large histories, or a lighter JS engine (FlexSearch / Orama / MiniSearch) over IndexedDB for simpler ops. The index must itself be encrypted at rest (reuse the PRF-derived DB key from the MLS spec).
- **Desktop (Tauri):** native SQLite FTS5 via a Rust command - simplest and fastest, no WASM/OPFS caveats. (This mirrors why Element can only do encrypted search on desktop: native index vs. browser-only is the hard case.)

### 4.3 Federation

`searchMessages(query, filters)` on the client:
1. fires the server `/search` request (plaintext channels), and
2. queries the local index (encrypted channels), if present and unlocked,
3. merges and ranks the two result sets (normalize scores; interleave by rank then recency),
4. labels encrypted results with a lock affordance.

Until MLS ships, step 2 is a no-op and federation is a pass-through to the server. The palette and results view never change.

---

## 5. The Command Palette (`Cmd/Ctrl+K`)

One palette, both tiers in a single result list - no separate results page. This is the unified entry point and the home of Tier 1. (Earlier drafts escalated message search to a dedicated `/search` page; that was dropped in favour of showing message hits inline, the Linear/Raycast/Notion model.)

**Contents, in priority order:**
1. **Before typing:** recent/frecent conversations + top quick-actions (Home, Agents, Members, Settings).
2. **As you type (instant, client-side):** channels / people / agents grouped by kind, fuzzy+frecency ranked; quick-actions by name.
3. **A "Messages" group, streamed in:** the debounced server content search (Tier 2) appears as its own group below the name groups. It never blocks the name tier - names render instantly; message hits fill in a moment later. Each row shows author + channel context + a `<mark>`-highlighted snippet.

**Interaction model:**
- `Cmd/Ctrl+K` toggles open/close; arrows navigate the whole flat list (names + messages, wrap); `Enter` activates; `Esc` closes and restores prior focus.
- Selecting a channel/person/action = instant navigation/execution, never a network wait.
- Selecting a message hit = navigate to its channel (deep-link scroll-to-message is Phase 2, via the `around` endpoint).
- The Messages group is capped (top ~8 by relevance). A "load more" affordance / in-channel scoping / operators land in Phase 2, inline in the palette.

**Performance budget:** sub-50ms for the instant tier (Slack renders its switcher in ~7-12ms doing exactly this). Only the remote content query is debounced (~180ms); the in-memory name list is never debounced.

---

## 6. Frontend Surfaces

**Desktop:**
- Register `Cmd/Ctrl+K` in the existing `ShortcutProvider` (`tinykeys`). Render the palette as a portal overlay reusing the Base UI `Dialog` primitive. A Search button in the `ChatsSidebar` header also opens it (`openCommandPalette()`).
- Message hits render inline in the palette's "Messages" group (`ts_headline` snippets with `<mark>` highlights). Operator chips, Recent/Relevant toggle, and "load more" are Phase 2 - inline in the palette.
- **In-channel search** (scope = current channel, `channel_id` filter) is a Phase 2 affordance.

**Mobile** (per the mobile shell: fixed-viewport inner-scroll, floating top bar, 4-tab pill + compose FAB):
- A Search button in the floating top bar opens the same palette (the Base UI `Dialog` centers fine on a phone viewport). Same unified menu - instant names + a streamed-in Messages group.

> **Open-then-dismiss gotcha:** a button *outside* the Base UI `Dialog` that imperatively opens it can have its opening pointer event caught by the dialog's outside-press dismissal, closing it instantly (the keyboard path is unaffected). Guarded two ways: `openCommandPalette()` defers the state flip a tick, and the palette ignores an `onOpenChange(false)` fired within 300ms of opening.

---

## 7. Deep-Link to a Message (build dependency)

Clicking a content-search result must scroll to and highlight a specific (possibly old) post in its channel. The current history endpoints page newest-first by `post_id`; jumping to an arbitrary historical post needs a new "load around" path:

```
GET /api/human/mm/channels/{channel_id}/posts?around_post_id={id}&radius=25
  -> returns up to `radius` posts on each side of `id`, so the client can
     render the target in context and visually highlight it.
```

This is a prerequisite for result click-through and is the least-obvious piece of work in the feature.

---

## 8. API

### Search messages (server tier)

```
GET /api/human/mm/search
  ?q=<query string, may contain operators>
  &org_id=<org>
  &channel_id=<optional: restrict to one channel/DM>
  &sort=relevant|recent           (default: recent)
  &cursor=<opaque keyset cursor>
  &limit=25
Authorization: session cookie (credentials: include), as today
```

**Response (200):**
```json
{
  "results": [
    {
      "post_id": 84213,
      "channel_id": "550e8400-...",
      "channel_display_name": "design-team",
      "channel_type": "private",
      "author": { "kind": "human", "id": 42, "display_name": "Dana Hale" },
      "created_at": "2026-06-10T14:03:22Z",
      "snippet": "the new <mark>search</mark> palette should ...",
      "rank": 0.83
    }
  ],
  "next_cursor": "eyJ...",
  "query_echo": { "text": "search palette", "filters": { "in": "design-team" } }
}
```

Encrypted-channel results (client tier) are produced locally and share this shape, merged by the client. The server endpoint never returns encrypted content.

### Search messages (agent tier)

```
GET /api/agentic/mm/search
  ?context_channel_id=<channel the agent is responding in — required>
  &q=... &channel_id=... &sort=... &cursor=... &limit=...
  &from_human_id=... &from_agent_id=... &before=... &after=... &has_link=&has_file=
Authorization: Bearer <agent api_key>
```

Same engine, same response shape plus a `scope` echo, with an agent-keyed ACL:
the membership join runs on `mm_channel_members.agent_id` and, on top of it, a
**context-derived channel allowlist** restricts what one request can retrieve:

| `context_channel_id` is… | Scope |
| :--- | :--- |
| The operator DM | `all_channels` — everything the agent is a member of |
| A public channel | `public_channels` — the agent's public channels |
| A private channel / other DM | `context_and_public` — that channel + public ones |

The middle tier is deliberately isolated in `TableRead._agent_middle_tier_scope`
so the policy can be tuned in one place. The allowlist is built from
`get_mm_channels_for_agent` (which already drops contact-revoked DMs), and the
operator DM is identified by the canonical membership resolver — never the
channel name.

**Guardrail, not boundary.** The scope narrows a single search request so an
agent responding in a public channel retrieves only public context. It is not
an access boundary: the agent can already read every channel it is a member of
through the normal read endpoints. Scope is recomputed per request; cursors do
not pin it.

Reads are unbilled (no CB_TOKENS cost). Deep-link context for a hit comes from
`GET /api/agentic/mm/channels/{channel_id}/posts/around/{post_id}` (plain
membership gate, statuses `streaming`+`published`).

### Frontend client function

`searchMessages(query, filters)` in `lib/api.ts` (plain `fetch`, `credentials:"include"`, query key `["mm","search",orgId,query,filters]`). It is the federation point described in 4.3.

---

## 9. Data Model & Migration Summary

| Change | Where | Notes |
| :--- | :--- | :--- |
| `CREATE EXTENSION pg_trgm` | migration | ships with stock Postgres; confirm enabled on managed prod |
| `mm_posts.message_tsv` (generated `tsvector`, STORED) | `mm_posts` | auto-synced; no worker |
| GIN index on `message_tsv` | `mm_posts` | the FTS index |
| GIN trigram index on `message` | `mm_posts` | typo/fuzzy fallback |
| `around_post_id` read path | `table_read` + endpoint | deep-link to message |
| (later, with MLS) `mm_channels.encrypted` | per encryption spec | enables defense-in-depth exclusion + UX routing |

No external service, no sync pipeline, no embedding model in v1.

---

## 10. Backend Evolution (behind the stable boundary)

Per the product decisions taken for this design:

- **Lexical only for now** (no semantic search). The `/search` boundary stays swappable; if "find by meaning" / RAG over history is wanted later, add `pgvector` + a hybrid keyword+vector path fused with Reciprocal Rank Fusion - without a frontend rewrite.
- **Best-UX-decide-later on the engine.** Start all-in-Postgres. The single product trigger to introduce **Meilisearch** (single-node, disk-mapped, tenant tokens, first-class typo tolerance and instant-as-you-type for *content*) is when typo-tolerant instant content search becomes a hard requirement - not table size. Postgres FTS comfortably serves millions of messages; the trigger is UX, not scale. If/when that happens, Meilisearch sits behind the same `/search` endpoint, fed by logical-replication CDC, with ACL replicated into scoped tenant tokens.

---

## 11. Privacy & Security Properties

| Property | Guarantee |
| :--- | :--- |
| No cross-org leakage | every query filtered by `org_id` |
| No cross-membership leakage | every query joins `mm_channel_members` for the caller |
| Agent context scoping | agent queries add a per-request channel allowlist derived from the context channel (see §8 agent tier) — a protocol guardrail layered on top of the membership join + `status='published'` invariants, which still hold on every agent query; not a hard boundary |
| Draft/rejected posts hidden | `status='published'` (plus the owner-only restricted-view rule) |
| Encrypted content never server-indexed | structural - ciphertext lives in `mls_encrypted_posts`, not `mm_posts`; the FTS column cannot see it |
| No searchable-encryption leakage | we do not use SSE; E2EE channels are searched client-side from decrypted state |
| Auditable | content-search queries are a natural audit-log point (who searched what, when) if compliance requires it |

---

## 12. Phased Rollout

- **Phase 0 - server foundation.** Migration (generated `tsvector` + GIN + `pg_trgm`); `GET /api/human/mm/search` with full ACL; `around_post_id` read path. Verifiable with API tests.
- **Phase 1 - unified palette (DONE).** `Cmd/Ctrl+K` palette + desktop/mobile triggers, Tier-1 fuzzy+frecency over channels/DMs/people/agents, quick-actions, AND Tier-2 message hits streamed inline as a "Messages" group. Click-through opens the channel.
- **Phase 2 - content search UX (inline).** Operators (`from:`/`in:`/`before:`), filter chips, Recent/Relevant toggle, "load more", in-channel scoping, and deep-link scroll-to-message (via the `around` endpoint) - all inside the palette.
- **Phase 3 - federation (with MLS).** Client-side encrypted-channel index co-located with MLS browser state; plug into `searchMessages()`; merged results. No palette/results changes.
- **Phase 4 - optional.** Meilisearch (only if typo-tolerant instant content search is required) and/or `pgvector` hybrid semantic (only if find-by-meaning is wanted).

---

## 13. Open Decisions

1. **Public-channel inclusion in global search** - membership-gated only (default, conservative) vs. include un-joined public channels in the org (Slack-like discovery).
2. **Searching your own drafts** - include the owner's `draft` posts in their results, or strictly `published` only.
3. **Attachment/file search** - whether `mm_files` filenames are in scope for v1 (`has:file` is listed, but filename matching is a separate index decision).
4. **`Recent` vs `Relevant` default** - the inline Messages group currently uses `relevant` (best few first); revisit if users expect chronological.
