# Chat widgets — design (chess, battleship, poker, blackjack)

Status: P1 implemented on `add-minigames` (uncommitted): backend, migration `35abc330f942`, web UI, tests. Kinds: `chess`, `battleship` (notebook rules, §5b), `poker` (heads-up hold'em, §5c), `blackjack` (two seats against the house, §5d).
P1 scope: human↔human `direct` DMs, web. Agents in P2.

## 0. Decisions (Mr L, 2026-10-07)

1. Chat toggle defaults to **off**.
2. **Silent updates**: an action changes the board in place; no post per move.
3. Agent widgets live in the **current chat** (P2).
4. A toggle **cannot be switched off while a widget is active** in its scope.
5. Name it something other than "game": the engine also serves animations.
6. **One UI pack** for all kinds; no package per game.
7. First step: human↔human chats.
8. Name: **widget** (confirmed).
9. Owner can **end all active widgets** in the org, which unblocks switching the org flag off.
10. Idle auto-abort after **2 days**.
11. Sidebar "your move": **quiet pawn glyph** (variant A).
12. Second kind: **battleship, notebook style** (graph paper, A–J × 1–10).
13. Third kind: **poker**, heads-up hold'em first; blackjack later on the same card table (2026-10-08).
14. Fourth kind: **blackjack** on the same table, plus a bet-size slider for both card games (2026-10-08).

## 1. Naming

| Term | Meaning |
|---|---|
| **widget** | Server-owned interactive object in a chat: `kind` + `state` + `rev`. Kinds: `chess` (P1); later `checkers`, `tictactoe`, `connect4`, `animation`. |
| **scene** | Declarative JSON view that a kind projects from its state. Data only, never code. |
| **`<SceneView>`** | The one client renderer, i.e. the "pack". |
| **action** | Generic input `{type, args}`, validated by the kind. |

- `widget` and `scene` are unused in the repo today (grep: 0 backend hits, 1 unrelated frontend test).
- Alternatives considered:
  - `scene` as the entity name: an org toggle "Enable scenes" is unclear.
  - "live block".
  - "applet": clashes with MCP Apps.

## 2. Architecture

Elm-style: `state` → `act(action)` → `state'` → `scene(state')`. The server is the only authority; the client knows no rules.

```
click ─► POST /widgets/{id}/actions {action, expected_rev}
            └► KINDS[kind].act(state, seat, action) ─► state', rev+1  (row lock, 1 UPDATE)
                 └► KINDS[kind].scene(state') ─► SSE widget.updated on channel:{id}
<SceneView> ◄─ react-query cache[widget_id] ◄──────────────────┘
```

New kind = backend module only; the client needs no release. This matters because desktop bundles `frontend/dist` and mobile ships through the app store.

## 3. UI pack

Options (from memory, not web-verified per the repo-only rule; confirm licenses and sizes before adopting):

| Option | Verdict |
|---|---|
| react-chessboard, cm-chessboard (MIT) | Chess only → one package per game. That is exactly what we avoid. |
| chessground | GPL-3.0, chess only. No. |
| boardgame.io (MIT) | JS engine + multiplayer with React bindings, but no board UI kit, and it duplicates the Python authority. No. |
| PixiJS / Phaser (MIT) | Generic 2D engines (games + animation), but canvas, ~0.3–1 MB, imperative code per kind, no React Native. At most a future lazy layer for particle-heavy animation. |
| Lottie / Rive | Playback of authored animation files. Possible future `lottie` / `rive` layer; no use for boards. |
| **In-house `SceneView` + one CC0 sprite atlas** | **Recommended.** One SVG renderer, zero per-kind client code. Mobile later = one `react-native-svg` port (already a dep) of the same vocabulary. |

### Rendering stack (no new dependencies)

| Concern | Web (P1) | Mobile (P2) |
|---|---|---|
| Components | React 19 (existing) | React Native (existing) |
| Drawing | Inline **SVG**: `<rect>` cells, `<use href="#chess-wK">` tokens from one CC0 `<symbol>` atlas | `react-native-svg` 15 (already a dep) |
| Motion | CSS transitions / Web Animations API on `transform` + `opacity`, keyed by token id (FLIP); `tw-animate-css` for enter/exit | `react-native-reanimated` 4 (already a dep) |
| Input | Pointer Events (click + drag), keyboard focus per cell | `react-native-gesture-handler` (already a dep) |
| Theme | Tailwind 4 tokens / CSS vars → light/dark for free | App theme |
| Data | TanStack Query cache keyed by `widget_id` + SSE `widget.updated` | Same |
| Loading | `React.lazy` → separate Vite chunk | — |

Why SVG/DOM and not a canvas engine (PixiJS / Phaser):
- Boards have ≤ ~100 elements.
- SVG is crisp at any DPI and themable with CSS vars.
- Each square can carry an `aria-label`.
- No manual hit-testing or retina scaling.
- Saves 0.3–1 MB of engine.

A canvas layer can be added later as a lazy scene layer type, only if particle-heavy animation ever needs it.

### Scene v1 vocabulary

```jsonc
{
  "v": 1,
  "board":  {"cols": 8, "rows": 8, "pattern": "checker", "labels": {"cols": "abcdefgh", "rows": "12345678"}},
  "tokens": [{"id": "wK", "sprite": "chess.wK", "at": "e1"}],      // stable id: an `at` change animates
  "marks":  [{"at": "e2", "tone": "last"}, {"at": "e4", "tone": "last"}, {"at": "e8", "tone": "danger"}],
  "seats":  {"white": {"human_id": 7}, "black": {"human_id": 9}},
  "turn":   "white",
  "flip_for": "black",                                             // viewer in that seat sees it rotated
  "input":  {"white": {"pick": {"e2": ["e3", "e4"]}, "choose": {"e7e8": ["q", "r", "b", "n"]}}},
  "status": {"text": "White to move", "tone": "neutral"},
  "actions": [{"type": "resign", "label": "Resign", "confirm": true}, {"type": "offer_draw", "label": "Offer draw"}],
  "timeline": null                                                 // keyframes played client-side (animations, replays)
}
```

- **Smooth motion**: the renderer animates a token by `id` when its `at` changes (CSS transform, GPU) and fades tokens in/out on add/remove.
- **Local selection**: `pick` precomputes the targets, so selecting a piece is instant. Only the commit makes a round trip.
  - `choose` is a generic follow-up picker (promotion here).
  - Optimistic: the token moves at once and the board stays locked until 200/409/422.
- **`timeline`**: `[{at_ms, token, to: {at | opacity | scale}}]` plus `loop`. Drives the `animation` kind and "replay" of a finished chess game, with no server round trips.
- **Safety**:
  - sprites by name from the bundled atlas only
  - text is plain
  - no HTML, SVG or URLs from the server → nothing to inject
- **Version skew**: unknown keys are ignored. If `v` is above what the client supports, it shows an "update app" placeholder plus the host post text.
- **Broadcast**: the scene is public and goes to the channel. Hidden-information kinds (cards) will later need per-seat scenes sent on `human:{id}`.
- **Size**: a chess scene is ~2–3 KB.

## 4. Data model (one migration, head `fe1d6327aa11`)

```sql
CREATE TABLE mm_widgets (
  widget_id    TEXT PRIMARY KEY,                       -- uuid4 hex
  channel_id   TEXT NOT NULL REFERENCES mm_channels(channel_id) ON DELETE CASCADE,
  host_post_id BIGINT NULL,                            -- the one post that shows the card
  kind         TEXT NOT NULL,                          -- validated against the KINDS registry
  status       TEXT NOT NULL CHECK (status IN ('active','finished','aborted')),
  rev          INT  NOT NULL DEFAULT 0,                -- compare-and-swap version
  state        JSONB NOT NULL,                         -- chess: {fen, moves_uci[], moves_san[], draw_offer}
  outcome      JSONB NULL,                             -- chess: {result: "1-0", termination: "checkmate"}
  created_by_human_id INT NULL REFERENCES human_users(id),
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX uq_mm_widgets_one_active ON mm_widgets(channel_id) WHERE status = 'active';

CREATE TABLE mm_widget_seats (                         -- generic: 0 seats (animation) .. N players
  widget_id TEXT NOT NULL REFERENCES mm_widgets(widget_id) ON DELETE CASCADE,
  seat      TEXT NOT NULL,                             -- 'white' | 'black'
  human_id  INT  NULL REFERENCES human_users(id),
  agent_id  TEXT NULL REFERENCES agents(agent_id),     -- P2
  PRIMARY KEY (widget_id, seat),
  CHECK ((human_id IS NULL) <> (agent_id IS NULL))
);
CREATE INDEX ix_mm_widget_seats_human ON mm_widget_seats(human_id) WHERE human_id IS NOT NULL;

ALTER TABLE mm_posts ADD COLUMN widget_id TEXT NULL;   -- metadata-only; FK added NOT VALID (no scan under lock)
ALTER TABLE organizations ADD COLUMN widgets_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE mm_channels   ADD COLUMN widgets_enabled BOOLEAN NOT NULL DEFAULT false;   -- decision 1
```

- `MmPostResponse.widget: {widget_id, kind} | None` comes from the column in `TableRead.hydrate_mm_posts` (`table_read.py:1766-1892`). No extra query; scene and state are never embedded in posts.
- Regenerate `db_schema.md`.

## 5. Kinds registry + chess

```python
class WidgetKind(Protocol):
    seats: tuple[str, ...]                                   # chess: ("white", "black")
    def init(self, options: dict) -> dict: ...
    def act(self, state: dict, seat: str | None, action: dict) -> tuple[dict, dict | None]: ...  # raises InvalidAction
    def scene(self, state: dict) -> dict: ...
KINDS: dict[str, WidgetKind] = {"chess": CHESS}
```

`clawbits/widgets/chess.py` is a pure-python rules module with no deps (`python-chess` is GPL-3.0; the repo is MIT and published images count as distribution). ~400 LOC:
- FEN
- legal moves: castling, en passant, promotion, pins
- SAN emit and parse
- endings: checkmate, stalemate, 50-move, threefold (by replaying `moves_uci`, ≤ ~5 ms at 200 plies), insufficient material

Piece sets (client-side, the scene still says `chess.wK`), both Mr L's drawings, cut from his sheets to transparent square webp (`pieces/{sea,classic}/*.webp` on web, `assets/images/pieces/{sea,classic}/*.webp` on mobile):
- **sea** (default since 2026-10-08): crab king, mermaid queen, narwhal bishop, seahorse knight, nautilus rook, starfish pawn. Since 2026-10-09 in the classic set's cream and black (remapped by lightness, details kept) and flatter: each pedestal pressed to 40% of its height, so the pieces fill more of their squares.
- **classic**: his Staunton set, colours as drawn, the baked drop shadows taken out (the board draws its own).
- Switch per device, from the game itself (two knights beside the title of any board that draws chess pieces) or, on the web, Settings → Appearance → "Chess pieces" (same choice, `fc_chess_pieces` in local storage). Mobile saves its pick on the phone (AsyncStorage).

## 5b. Battleship (notebook rules) and private scenes

`clawbits/widgets/battleship.py`, seats `red` (shoots first) and `blue`:
- 10×10, A–J across, 1–10 down. Fleet of ten straight ships: 4, 3, 3, 2, 2, 2, 1, 1, 1, 1 cells; ships never touch, corners included.
- Setup: fleets start random; until **Ready** each seat may **Shuffle**, or **move** a ship (`{from, to}` by its first cell; `to == from` turns it, about its middle where there is room, else about the cell nearest that which has it), every place offered in `input.pick` and checked by the notebook rules. Clients hold a ship by any cell, drag it or tap it then a cell; a held ship shows a turn button at its middle (dimmed, saying so, when it has no room), and a second tap turns it too. A turned ship stays held, found again by its token id, so it can turn back at once. Battle starts once both are ready; abort only before it. Boards carry a screen-reader `label`, no visible title, and name their `seat`: clients set that player's avatar beneath each board and the viewer's buttons beside theirs, with no names or status on show (the status speaks to screen readers only).
- A hit earns another shot. A sunk ship rings itself with misses (`near` marks) that can't be fired at. Last ship sunk wins; resign during battle.

Fleets are secret, so the kind is **private** (`WidgetKind.private`):
- `scene(state, status, outcome, seat)` shows a seat its own fleet; `seat=None` (anyone else, and every realtime event) sees only sunk ships until the game ends.
- Reads (`GET`, list, create and act responses) carry the caller's own scene; `widget.updated` carries the public one with `private: true`, and clients refetch their own view (skipped when they already hold that rev).

Scene vocabulary grew for it, still one renderer: `boards[]` (several boards), `style: "notebook"` (graph paper, labels outside), `origin: "top"`, tokens with `span` (ships), pencil marks (`hit` ✕, `miss`/`near` dots), and `tap` input (one-step actions, `{at}`) beside `pick` (two-step, `{from, to, choice}`).

## 5c. Poker (heads-up hold'em) and the card table

`clawbits/widgets/poker.py`, seats `red` (deals first) and `blue`; ranking and the deck in `clawbits/widgets/cards.py` (pure Python, `secrets`-grade shuffle):
- No limit. 1000 chips each, blinds 10/20 doubling every 10 hands, so a match ends. The dealer posts the small blind, acts first before the flop, last after.
- Actions: `fold`, `check`, `call`, `bet`/`raise` with `args.to` (what the seat's bet on the street comes to; min raise = last raise), `allin` (a call when no raise is left). All-in and called: the board runs out at once.
- A fold deals the next hand at once. A showdown waits for either seat's `deal`, so both see the hands (`turn` = the next dealer). One seat holding every chip ends the match; resign any time, abort in hand 1.
- **Chips are play money for this widget only**: nothing converts them to or from CB_TOKENS or anything of value.
- Private kind: a seat sees its own two cards; the other's show only at a showdown. The deck lives in `state`, which no response carries.

Bet sizes: an `amount` on an action (`{arg, min, max, step, value, presets}`) draws quick picks (Min, ½ pot, Pot), a slider with a step either side, and a button that sends `args[arg]`.

Scene vocabulary, still one renderer: `table.rows[]` (cards as `As`/`Td`, `back`, `null` for an empty place; a `note` per row; `lift` for a winning hand), `seat_notes` (chips and dealer, shown in place of the seat name), and `args` on an action (bet presets). Log lines are viewer-relative (`You raise to 60.`, `They call 40.`).

## 5d. Blackjack (two seats against the house)

`clawbits/widgets/blackjack.py`, seats `red` and `blue` at one table, the dealer played by the rules:
- 1000 chips each, ten rounds; more chips after the last wins, equal is a draw, a seat that can't cover the 10-chip minimum ends it early. Bets in tens (3:2 stays whole).
- A round: both seats `bet` (`args.amount`, the slider; it defaults to the last bet), then a fresh deck deals. Dealer peeks on an ace or ten. Seats play in turn, first seat alternating by round: `hit`, `stand`, `double` (two cards), `split` (one pair, unlike tens too; split aces one card each; 21 after a split isn't blackjack). Dealer stands on soft 17. Blackjack pays 3:2.
- No insurance or surrender yet.
- Every card is face up but the dealer's hole card, so nothing is secret between seats; `private` gives each seat its own wording. The hole card shows as `back` until the dealer plays.
- The table: the other seat's hands, the dealer, the viewer's hands; a row per hand after a split, the hand in play marked `active`; past five cards a row fans.

## 6. API (P1, humans)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/human/mm/channels/{channel_id}/widgets` | `{kind, options}`. Creates the widget and its host post. See checks below. |
| GET | `/api/human/mm/widgets/{widget_id}` | `{widget_id, channel_id, kind, status, rev, seats, scene, outcome}`. Requires membership of its channel. |
| GET | `/api/human/mm/channels/{channel_id}/widgets?status=active` | Feeds the dock (§8). |
| POST | `/api/human/mm/widgets/{widget_id}/actions` | `{action: {type, args}, expected_rev}` → 200. 403 not your seat or turn; 409 stale rev or not active; 422 invalid. Hints go in `detail`, because the global handler drops headers. |
| GET / PUT | `/api/human/orgs/{org_id}/widgets` | Member read, owner write, audited. Pattern: attention endpoints at `human_endpoints.py:1866-1892`. |
| PATCH | `/api/human/mm/channels/{channel_id}` | `+ widgets_enabled`. Extends `MmChannelPatchRequest` (`extra="forbid"`). |

**Create checks:**
- caller is a human member (`_require_human_member`)
- `channel_type == 'direct'` and both members are human (P1)
- org and chat flags both on
- no active widget in the chat (409, also enforced by the unique index)
- `_rate_limit` (`human_endpoints.py:164-194`)

**Action transaction:**
1. `SELECT … FOR UPDATE` on the widget row.
2. Check it is active, the seat is the caller's, and `rev == expected_rev`.
3. `act`, then `UPDATE … rev = rev + 1`, then commit.
4. Publish `widget.updated`.

**No post is written** (decision 2).

## 7. Realtime

- `widget.updated` (`{widget_id, channel_id, rev, status, scene, outcome}`) on `channel:{id}` only.
  - Add it to `RealtimeEventType` (`mm_models.py:90-108`).
  - Web `useChannelEvents.ts`: `setQueryData(queryKeys.mm.widget(id))`, guarded by `rev`.
- Optional (open): a tiny `widget.turn` event to the opponent's `human:{id}` topic, shown as a sidebar "your move" signal. No push, no unread, so updates stay silent.
  - Variants:
    - **A: quiet pawn glyph** in the row's right slot (proposed)
    - B: "your move" pill
    - C: pawn badge on the avatar
  - In `MainSidebar.tsx`, A is a new `Signal` kind `{kind: "turn"}` in the existing ladder (`signalOf`, `:355-363`): mention > unread count > **turn** > working > pinned > time.
  - Not counted in `hiddenSignal` (collapsed scopes), so it stays silent.
- Safe for old consumers: web, mobile, OpenClaw and Hermes dispatch by if-chains and ignore unknown types (`useChannelEvents.ts:222-323`, `apps/mobile/src/lib/data.tsx:256-283`, `plugin/src/inbound-poller.ts:1488,1562-1622`, `extensions/hermes/adapter.py:1133-1148`). IronClaw's serde ignores unknown fields.

## 8. Web UI

- **Host post**, the only post:
  - Text: `♟ Alice started a chess game · <app>/widgets/<id>`.
  - It is a normal post, so the invite (not the moves) gets unread + push.
  - The text is the fallback for old desktop builds, mobile, search and export.
- **Card**: `MessageRow`: `post.widget` → `<WidgetCard>` → lazy `<SceneView>`.
  - A fixed-aspect skeleton is reserved before the chunk loads, so virtua doesn't jump.
  - State comes from the query cache by `widget_id`, not from post fields. That survives row unmount and the "older pages never update" caveat (`channelTimeline.ts:39-50`).
- **Dock above composer**: a collapsed bar `♟ Chess vs Bob · your move` that expands to the same `SceneView`.
  - Needed because silent updates leave the host post scrolled away as people chat.
  - Fed by `GET …/widgets?status=active` plus `widget.updated`.
- **Start**: composer menu `Widgets ▸ Chess` and a `/chess` command, visible only when both flags are on.
- **Settings**:
  - Org → new "Widgets" page, owner only (pattern `SettingsLobstertalkPage.tsx`).
  - Channel info (`ChatInfoSidebar.tsx:26-104`) → switch, disabled with a reason while a widget is active.
- **Standalone page** `/widgets/{id}` (pattern `McpConnectPage.tsx`) for clients that can't render the card.
- **Bundle**: `SceneView` + atlas live in a lazy chunk → 0 bytes in the main chunk. No CSP change (no iframe, no new origin).

Panel (both apps, since 2026-10-09): no title row and no kind glyph (the dock names the game); each player's avatar wears their seat's tone, ivory or ebony by seat order as the chess sides (Mr L's pick), which no action button uses, and the seat to move is ringed in the accent. One middle area between the players shows one thing at a time: while playing, the status over the viewer's actions grouped in one box; while the notes button is on, the notes (the whole log, latest in view) in their place, until switched off; once over, the result as one line from the viewer's side: `🏆 You won`, `💔 You lost` (a broken heart of its own, never the resign flag), `🤝 Draw`, `Ended`, or `🏆 <winner> won` for a spectator; its reason (each kind's final status is the reason alone: `Black resigned`, `Checkmate`, `Your fleet is sunk`) a tooltip and a screen reader's. The middle sits in the right column between the opponent above and the viewer below, or, for a board a seat (battleship), in one row beneath the boards between the viewer's avatar at the left and the other's at the right, each named beside its avatar, facing the middle (the names give way before the middle does). The notes button and piece switch keep a corner of their own. Card games keep no notes (their table tells the hand). Actions are icons, keeping the number a label carries (`Call 10`, `All-in 990`), their labels as names and tooltips. All-in is a four-leaf clover (Lucide's `Clover`; drawn from the same path on iOS, which SF Symbols lacks, as is the broken heart). A widget's message shows no read receipt.

Dock (both apps, since 2026-10-09): a round glass button at the composer's top-right corner rather than a full-width bar; the game's glyph, a dot when it's your move (said in its label too). A tap scrolls the chat to the message that started the game (`post_id` on every widget; failing that, the loaded message carrying the widget), loading older history if it must, and centres it; it opens no view of its own. While that game is on screen the dock steps aside (web: the card's IntersectionObserver; mobile: the list's viewability), and while it shows it takes a lane above the composer, which the chat keeps clear, so it never covers a message or a read receipt (Mr L, 2026-10-09).

## 8b. Mobile (`apps/mobile`, iOS)

Ported 2026-10-08, all four kinds through the same scene vocabulary; still no per-kind code:
- `src/lib/widgets.ts`: types and pure helpers (caches, seats, board geometry, cards, amounts), tested with bun. `api.ts` gains the widget calls and a PATCH for the chat switch; `data.tsx` handles `widget.updated` (private → refetch), `widget.turn` and `channel.widgets`, and the `useWidget` / `useActiveWidgets` / `useWidgetAction` hooks.
- `src/components/widgets/`: react-native-svg pieces, suits and cards; `BoardView` (two taps per move, promotion chooser, graph paper, pencil marks, pieces slide with Reanimated CSS transitions); `CardTable` (felt, fanned rows, lifted winning cards, dealt cards fade in); `WidgetPanel` (stacked: opponent, scene, you, status, log, buttons; confirmations in the system alert; a slider built on PanResponder with VoiceOver adjust); `WidgetDock` (glass bar above the composer, the game in a page sheet).
- The chat shows the widget in place of its message's text; the + menu offers "Play a Game" in a DM between people when the org allows it and none is running, and asks to turn the chat's switch on first. The inbox row shows a quiet game-controller symbol when a game waits on you.
- Palette: the web's OKLCH roles as sRGB hex for light and dark, on iOS neutrals.
- No drag-to-move yet (taps only). Built and checked against the installed SDK 57 packages; not yet run on a device.

## 9. Toggles (decisions 1 + 4)

- **Effective** = `org.widgets_enabled AND channel.widgets_enabled`. Both default off.
- **Chat**: any human member may toggle. Off → 409 while an active widget exists in the chat.
- **Org**: owner only. Off → 409 while any active widget exists in the org; `detail` carries the count and chats. The query is cheap: the partial index on active widgets + the channels-by-org index.
- **Race**:
  - Create takes `FOR SHARE` on the org row and `FOR UPDATE` on the channel row.
  - Disable takes `FOR UPDATE` on the same row.
  - So no create can slip in after a disable is checked.
- **Invariant**: active widget ⇒ both flags on. Actions recheck the flags anyway as a cheap guard.
- **Escape hatches** (required, or one abandoned game blocks switch-off forever):
  - Either seat may resign or abort at any time.
  - Idle reaper aborts after **2 days** without an action (decision 10). Pattern: streaming reaper task in `clawbits/fastapi/mm_maintenance.py` started in `main.py:203`.
  - Member removed from org (`TableWrite.remove_org_member`, `table_write.py:1851`) → abort their active widgets.
  - Host post deleted (`TableWrite.delete_mm_post_human`, `table_write.py:3296`) → abort the widget.
  - **Owner end-all** (decision 9): `POST /api/human/orgs/{org_id}/widgets/end-active`.
    - Owner only, audited.
    - Aborts every active widget in the org and publishes `widget.updated` for each.
    - The settings page offers it when switch-off returns 409: "N widgets are active · End all and turn off".

## 10. Breakage / performance

| Area | Effect | Mitigation |
|---|---|---|
| Per action | 1 row lock + 1 UPDATE + 1 SSE publish (~2–3 KB). No post insert, fan-out, push or unread recount. | — |
| CPU | Chess legal moves + scene ~1–2 ms, threefold replay ≤ ~5 ms, per action only. | Never compute in list endpoints. |
| `mm_posts ADD COLUMN widget_id` | Nullable → metadata-only. A plain FK would scan the table under lock. | `NOT VALID` FK, validate later (or skip the FK). |
| Hydrate | +1 column, no extra query. | — |
| Normal post path | Unchanged. | — |
| Agents | P1 creates widgets only in human↔human DMs, so no agent ever sees one. | Agent WS forwards channel events only for its own channels. |
| Client render | SVG with 64 cells + ≤32 tokens; transform animations on the GPU. | Only the card + dock are mounted per widget. |
| Old clients | Show the host post text + link. | Deploy backend (flags off) → web → enable. |
| IronClaw | Only `published` posts flow. | The host post is `published`; never add a new post status. |
| DM channel events | Suppressed for pair channels (`table_write.py:2894-2896`). | Don't use `mm_channel_events`. |
| Spam | No post rate limits exist. | `_rate_limit` on create; one active widget per chat. |
| Forgery | — | `post.widget` is set server-side only (`MmPostRequest` is `extra="forbid"`). The card renders only if `widget.channel_id == post.channel_id`. |
| Silent-update cost to UX | The opponent isn't notified of moves. | Dock + optional `widget.turn` sidebar dot. |

## 11. P2 — agents (current chat, silent)

- **Wake**: with no move posts, agents need another trigger: a control event `widget.turn` on `agent:{id}` (like `turn.stop` / `model.selection`). OpenClaw and Hermes then start a turn with a synthetic prompt.
- **Tools**: `clawbits_widget_get`, `clawbits_widget_act`. An invalid action returns the legal list so the agent can retry in the same turn.
- **Risks**:
  - The synthetic inbound has no post id, so it must bypass the plugin watermarks and read cursors.
  - It lands in the current chat session → context growth, and 1 LLM turn per human move.
  - IronClaw has no WS control path → unsupported. Gate on `agents.agent_type` / `plugin_version` (`models.py:136-138`).
- **Bonus**: agents can post `animation` widgets (scene `timeline`). That is the "engine for animation" case.

## 12. Phases

- **P1** (human↔human, web):
  - chess rules + `KINDS` registry
  - migration
  - endpoints + `widget.updated`
  - `SceneView` + CC0 atlas
  - card + dock
  - toggles + escape hatches + reaper
  - tests
- **P2**:
  - mobile `SceneView` (`react-native-svg`)
  - agents (§11)
  - `widget.turn` dot
  - `animation` kind / `timeline`
  - chess replay
- **P3**:
  - checkers / connect4 / tictactoe (backend-only)
  - hidden-info per-seat scenes
  - group channels with spectators
  - MCP bridge

## 13. Tests

- `tests/widgets/test_chess_rules.py`:
  - perft — start d1-3 = 20 / 400 / 8902; Kiwipete d1-2 = 48 / 2039
  - SAN round trip
  - every ending; castling, en passant and promotion edge cases
- `tests/fastapi/test_widgets.py`:
  - create: a flag off → 403; non-human DM → 422; active exists → 409
  - actions: wrong seat or turn → 403; invalid → 422; stale rev → 409
  - no post written per action; `widget.updated` published (pattern `test_realtime_publish.py`)
  - toggles: off with an active widget → 409 (chat and org); owner-only org; create/disable race
  - escape hatches: reaper, org member removal, host post delete
- Frontend (vitest):
  - `SceneView` pick/choose
  - animation keyed by token id
  - `rev` guard
  - unknown `v` placeholder

## 14. Open

None for P1. P2 (mobile, agents) per §11–12.
