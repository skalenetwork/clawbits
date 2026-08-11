//! Clawbits agentic messaging channel for IronClaw.
//!
//! This WASM component bridges an IronClaw agent to the Clawbits messaging
//! platform over the `/api/agentic/*` HTTP API — the same surface the OpenClaw
//! "Clawbits Human Channel" plugin uses. To the IronClaw runtime, Clawbits
//! plays the role Telegram/Slack play: humans and other agents in a Clawbits
//! org are the "users", and the IronClaw agent is the bot.
//!
//! # Transport
//!
//! - Inbound: polling. On each tick the channel lists its channels and fetches
//!   new posts, emitting anything past a per-channel watermark. Watermarks for
//!   all channels live in one JSON map at [`WATERMARKS_PATH`] so the host can
//!   persist them durably across restarts (declared in
//!   `clawbits.capabilities.json` `durable_workspace_paths`).
//! - A still-`streaming` post blocks the watermark from advancing (it flips to
//!   `published` under the same post_id — skipping it would lose the message),
//!   but an *abandoned* stream must not mute the channel forever: a post that
//!   blocks the barrier for [`STREAMING_BARRIER_TTL_MS`] is skipped.
//! - Outbound: `POST .../posts`. The reply target (channel id) rides the
//!   emitted message's `metadata_json` and is handed back on `on_respond`.
//! - Liveness: `POST /api/agentic/alive` on activation and every
//!   [`ALIVE_PING_INTERVAL_MS`] thereafter — the same ping the OpenClaw plugin
//!   sends, so the Clawbits status dot, agent-card runtime sticker, and the
//!   creation wizard's ready gate treat IronClaw agents identically.
//!
//! # Auth
//!
//! - The Clawbits API key is injected as a bearer token by the host; the WASM
//!   never sees it (declared in `clawbits.capabilities.json`).
//! - Writes are billed in CB_TOKENS. When the balance is exhausted the server
//!   returns 402; the channel replenishes by solving a deterministic challenge
//!   (a dictionary lookup, see [`known_answers`]) against
//!   `/api/agentic/auth/challenge_response`, then retries.

// Generated bindings expose types we don't all use directly.
#![allow(dead_code)]

// Generate bindings from the vendored WIT interface. This is a copy of
// ironclaw's `wit/channel.wit` (package `near:agent@0.3.1`); keep it in sync
// when the IronClaw channel ABI changes — see README.md.
wit_bindgen::generate!({
    world: "sandboxed-channel",
    path: "wit/channel.wit",
});

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use exports::near::agent::channel::{
    AgentResponse, ChannelConfig, Guest, IncomingHttpRequest, OutgoingHttpResponse, PollConfig,
    StatusType, StatusUpdate,
};
use near::agent::channel_host::{self, EmittedMessage, HttpResponse, InboundAttachment};

mod known_answers;

// ============================================================================
// Constants & workspace state paths
// ============================================================================

/// Default Clawbits endpoint when the config omits one. Must be covered by the
/// HTTP allowlist in `clawbits.capabilities.json`.
const DEFAULT_ENDPOINT: &str = "https://app.clawbits.ai";

/// Clawbits caps a post body at 4000 chars; we split longer replies.
const MAX_MESSAGE_LEN: usize = 4000;

/// Newest-N posts fetched per channel per poll. Posts past the watermark are
/// emitted; the rest are ignored. With a 30s+ poll interval this comfortably
/// covers normal chat volume.
const POSTS_PER_POLL: u32 = 100;

/// Max attempts to draw a challenge question we have a bundled answer for.
const CHALLENGE_ATTEMPTS: usize = 16;

/// How long a non-`published` post may block a channel's delivery barrier
/// before it is treated as abandoned and skipped. A healthy streaming post is
/// PATCHed every few seconds and finalises in well under a minute; one whose
/// owner crashed mid-stream never finalises — the server keeps it in
/// `streaming` indefinitely, and without this cutoff every later post in the
/// channel would be fetched forever but never delivered.
const STREAMING_BARRIER_TTL_MS: u64 = 10 * 60 * 1000;

/// All per-channel delivery watermarks as one JSON map
/// (`{"<channel_id>": <post_id>}`). A single well-known path — rather than the
/// legacy per-channel `state/wm_*` files — because the host persists durable
/// workspace state by exact path match; this is the entry named in
/// `clawbits.capabilities.json` `durable_workspace_paths`.
const WATERMARKS_PATH: &str = "state/watermarks";

/// Barrier bookkeeping as one JSON map
/// (`{"<channel_id>": {"post_id": N, "since_ms": T}}`): which post is currently
/// blocking each channel's watermark and since when. Deliberately NOT durable —
/// after a restart the TTL clock simply re-arms.
const BARRIERS_PATH: &str = "state/barriers";

/// Liveness-ping cadence, mirroring the OpenClaw plugin (startup + every ~10
/// min, see `plugin/src/liveness.ts`): the server flips the agent "available"
/// on a ping and derives the offline transition purely from `last_alive_at`
/// age, so the cadence just has to stay under that horizon.
const ALIVE_PING_INTERVAL_MS: u64 = 10 * 60 * 1000;

/// Timestamp (ms) of the last *successful* alive ping. Deliberately NOT
/// durable — a restart pings again on activation, which is exactly the
/// "on startup" half of the cadence.
const LAST_ALIVE_PATH: &str = "state/last_alive_ping";

const ENDPOINT_PATH: &str = "state/endpoint";
/// Agent id from config (an explicit operator override).
const AGENT_ID_PATH: &str = "state/agent_id";
/// Agent id auto-learned from the `agent_id` clawbits stamps on the posts this
/// channel creates. Lets the channel skip its own posts (avoid an echo loop)
/// without the operator configuring `agent_id` by hand.
const SELF_AGENT_ID_PATH: &str = "state/self_agent_id";
const CHANNEL_ID_PATH: &str = "state/channel_id";
const ALLOW_FROM_PATH: &str = "state/allow_from";
/// Operator override for the server's attachments-per-post cap
/// (MM_FILES_MAX_PER_POST); see `max_files_per_post` in ClawbitsConfig.
const MAX_FILES_PER_POST_PATH: &str = "state/max_files_per_post";

// ============================================================================
// Config (passed to on_start) — mirrors clawbits.capabilities.json `config`
// ============================================================================

#[derive(Debug, Deserialize)]
struct ClawbitsConfig {
    /// Clawbits API base URL (default `https://app.clawbits.ai`).
    #[serde(default)]
    endpoint: Option<String>,
    /// This agent's Clawbits agent id (used to skip the agent's own posts).
    #[serde(default)]
    agent_id: Option<String>,
    /// Optional single channel to watch. When set, only this channel is polled;
    /// otherwise every channel the agent is a member of is polled.
    #[serde(default)]
    channel_id: Option<String>,
    /// Optional inbound sender allowlist, e.g. `["human:123","agent:agent_abc"]`.
    /// Empty means accept all senders (except the agent itself).
    #[serde(default)]
    allow_from: Option<Vec<String>>,
    /// Poll interval in milliseconds (host floor is 30000).
    #[serde(default)]
    poll_interval_ms: Option<u32>,
    /// Attachments per post. Must match the server's MM_FILES_MAX_PER_POST
    /// (default 5) — set this when the operator lowered the server cap, or
    /// posts with more file_ids come back 400.
    #[serde(default)]
    max_files_per_post: Option<u32>,
}

// ============================================================================
// Clawbits API DTOs (subsets — serde ignores unknown fields)
// ============================================================================

#[derive(Debug, Deserialize)]
struct ChallengeQuestion {
    session_token: String,
    /// Serialized under the alias `challenge` on the wire.
    challenge: String,
}

#[derive(Debug, Deserialize)]
struct MmChannelListResponse {
    channels: Vec<MmChannel>,
}

#[derive(Debug, Deserialize)]
struct MmChannel {
    channel_id: String,
}

#[derive(Debug, Deserialize)]
struct MmPostListResponse {
    posts: Vec<MmPost>,
}

#[derive(Debug, Deserialize)]
struct MmPost {
    post_id: i64,
    channel_id: String,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    human_id: Option<i64>,
    #[serde(default)]
    poster_display_name: Option<String>,
    #[serde(default)]
    message: String,
    #[serde(default = "default_status")]
    status: String,
    /// Chat attachments on the post (images carry an inline presigned
    /// `download_url`; other types resolve on demand server-side).
    #[serde(default)]
    files: Vec<MmFileInfo>,
}

/// The slice of the server's `MmFileResponse` the channel forwards to the
/// host as an inbound attachment.
#[derive(Debug, Deserialize)]
struct MmFileInfo {
    file_id: String,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    size_bytes: Option<i64>,
    #[serde(default)]
    download_url: Option<String>,
    #[serde(default)]
    width: Option<i64>,
    #[serde(default)]
    height: Option<i64>,
}

fn default_status() -> String {
    "published".to_string()
}

/// Stashed on the inbound emit; handed back verbatim on `on_respond` so the
/// reply lands in the right channel.
#[derive(Debug, Serialize, Deserialize)]
struct ClawbitsRouting {
    channel_id: String,
    post_id: i64,
}

/// One channel's barrier bookkeeping (stored in the [`BARRIERS_PATH`] map):
/// the non-published post currently blocking the watermark, and when it was
/// first seen blocking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct BarrierRecord {
    post_id: i64,
    since_ms: u64,
}

// ============================================================================
// Channel
// ============================================================================

struct ClawbitsChannel;

impl Guest for ClawbitsChannel {
    fn on_start(config_json: String) -> Result<ChannelConfig, String> {
        let config: ClawbitsConfig = serde_json::from_str(&config_json)
            .map_err(|e| format!("Failed to parse config: {}", e))?;

        let endpoint = config
            .endpoint
            .as_deref()
            .map(|s| s.trim_end_matches('/'))
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_ENDPOINT)
            .to_string();
        persist(ENDPOINT_PATH, &endpoint);

        if let Some(ref agent_id) = config.agent_id {
            persist(AGENT_ID_PATH, agent_id);
        } else {
            persist(AGENT_ID_PATH, "");
        }

        match config.channel_id.as_deref() {
            Some(id) if !id.is_empty() => persist(CHANNEL_ID_PATH, id),
            _ => persist(CHANNEL_ID_PATH, ""),
        }

        let allow_from_json = serde_json::to_string(&config.allow_from.clone().unwrap_or_default())
            .unwrap_or_else(|_| "[]".to_string());
        persist(ALLOW_FROM_PATH, &allow_from_json);

        match config.max_files_per_post {
            Some(n) if n >= 1 => persist(MAX_FILES_PER_POST_PATH, &n.to_string()),
            _ => persist(MAX_FILES_PER_POST_PATH, ""),
        }

        // Validate credentials and pre-mint CB_TOKENS in one step. A 401 here
        // means the API key is bad — fail activation rather than spin in a
        // doomed poll loop (auth rejection is terminal). Pass the resolved
        // endpoint directly: it is not yet readable back from the workspace.
        match mint_tokens(&endpoint) {
            Ok(()) => channel_host::log(
                channel_host::LogLevel::Info,
                "Clawbits channel authenticated and topped up CB_TOKENS",
            ),
            Err(e) if e.contains("unauthorized") => {
                return Err(format!("Clawbits API key validation failed: {}", e));
            }
            Err(e) => channel_host::log(
                channel_host::LogLevel::Warn,
                &format!("Clawbits token mint at startup failed (will retry on 402): {}", e),
            ),
        }

        // First liveness ping. The creation wizard's "Almost ready…" gate and
        // the agent card's runtime sticker both hang off `POST
        // /api/agentic/alive` (`last_alive_at` + self-reported agent_type);
        // without it an IronClaw agent shows "setting up" forever. Best-effort
        // — activation must not fail on a missed ping; `on_poll` retries.
        ping_alive(&endpoint, channel_host::now_millis());

        let interval_ms = config.poll_interval_ms.unwrap_or(30000).max(30000);

        Ok(ChannelConfig {
            display_name: "Clawbits".to_string(),
            // Outbound-connect channel: no inbound webhook endpoint.
            http_endpoints: vec![],
            poll: Some(PollConfig {
                interval_ms,
                enabled: true,
            }),
        })
    }

    fn on_http_request(_req: IncomingHttpRequest) -> OutgoingHttpResponse {
        // Clawbits is polled, not webhooked. Nothing routes here.
        OutgoingHttpResponse {
            status: 404,
            headers_json: "{}".to_string(),
            body: Vec::new(),
        }
    }

    fn on_poll() {
        let endpoint = endpoint();

        // Refresh liveness before touching channels: reachability and message
        // flow are separate signals, so a failing channel list must not let
        // the agent decay to "offline" while the process is plainly alive.
        maybe_ping_alive(&endpoint, channel_host::now_millis());

        let self_agent_id = current_self_agent_id();
        let allow_from: Vec<String> = read(ALLOW_FROM_PATH)
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let channel_ids = match channels_to_poll(&endpoint) {
            Ok(ids) => ids,
            Err(e) => {
                channel_host::log(
                    channel_host::LogLevel::Error,
                    &format!("Clawbits poll: failed to list channels: {}", e),
                );
                return;
            }
        };

        // Workspace writes commit at callback end and are not readable back
        // within the same callback, so a per-channel read-modify-write of the
        // shared maps would drop every update but the last. Load both maps
        // once, mutate in memory across all channels, persist once if changed.
        let mut watermarks = load_state_map::<i64>(WATERMARKS_PATH);
        let mut barriers = load_state_map::<BarrierRecord>(BARRIERS_PATH);
        let watermarks_before = watermarks.clone();
        let barriers_before = barriers.clone();
        let now_ms = channel_host::now_millis();

        for channel_id in channel_ids {
            if let Err(e) = poll_channel(
                &endpoint,
                &channel_id,
                &self_agent_id,
                &allow_from,
                &mut watermarks,
                &mut barriers,
                now_ms,
            ) {
                channel_host::log(
                    channel_host::LogLevel::Warn,
                    &format!("Clawbits poll: channel {} failed: {}", channel_id, e),
                );
            }
        }

        if watermarks != watermarks_before {
            persist_state_map(WATERMARKS_PATH, &watermarks);
        }
        if barriers != barriers_before {
            persist_state_map(BARRIERS_PATH, &barriers);
        }
    }

    fn on_respond(response: AgentResponse) -> Result<(), String> {
        let routing: ClawbitsRouting = serde_json::from_str(&response.metadata_json)
            .map_err(|e| format!("Failed to parse routing metadata: {}", e))?;
        deliver_response(&routing.channel_id, &response)
    }

    fn on_broadcast(user_id: String, response: AgentResponse) -> Result<(), String> {
        // `user_id` is the target channel id for a proactive message.
        deliver_response(&user_id, &response)
    }

    fn on_status(update: StatusUpdate) {
        let routing: ClawbitsRouting = match serde_json::from_str(&update.metadata_json) {
            Ok(r) => r,
            // No channel context (e.g. a global status) — nothing to address.
            Err(_) => return,
        };
        let presence = match classify_status(&update.status) {
            Some(p) => p,
            None => return,
        };
        let path = format!(
            "/api/agentic/mm/channels/{}/status",
            encode_segment(&routing.channel_id)
        );
        let body = serde_json::json!({ "status": presence });
        // Best-effort: a failed typing indicator must not break the turn.
        let _ = api_post(&endpoint(), &path, &body);
    }

    fn on_shutdown() {
        // Nothing durable to unwind; presence decays server-side.
    }
}

// ============================================================================
// Inbound polling
// ============================================================================

/// The set of channels to poll: the single configured channel if set, else
/// every channel the agent can see.
fn channels_to_poll(endpoint: &str) -> Result<Vec<String>, String> {
    if let Some(id) = read(CHANNEL_ID_PATH).filter(|s| !s.is_empty()) {
        return Ok(vec![id]);
    }
    let resp = api_get(endpoint, "/api/agentic/mm/channels", Some(15_000))?;
    if resp.status != 200 {
        return Err(format!("list channels returned {}", resp.status));
    }
    let parsed: MmChannelListResponse = serde_json::from_slice(&resp.body)
        .map_err(|e| format!("parse channel list: {}", e))?;
    Ok(parsed.channels.into_iter().map(|c| c.channel_id).collect())
}

#[allow(clippy::too_many_arguments)]
fn poll_channel(
    endpoint: &str,
    channel_id: &str,
    self_agent_id: &str,
    allow_from: &[String],
    watermarks: &mut BTreeMap<String, i64>,
    barriers: &mut BTreeMap<String, BarrierRecord>,
    now_ms: u64,
) -> Result<(), String> {
    let path = format!(
        "/api/agentic/mm/channels/{}/posts?limit={}",
        encode_segment(channel_id),
        POSTS_PER_POLL
    );
    let resp = api_get(endpoint, &path, Some(15_000))?;
    if resp.status != 200 {
        return Err(format!("list posts returned {}", resp.status));
    }
    let parsed: MmPostListResponse =
        serde_json::from_slice(&resp.body).map_err(|e| format!("parse posts: {}", e))?;

    // First sight of this channel: anchor the watermark at the newest post
    // without replaying history, then start emitting on the next tick.
    // (Legacy fallback: pre-map layouts stored one `state/wm_*` file per
    // channel; honor it once, then the map is the source of truth.)
    let watermark = match watermarks
        .get(channel_id)
        .copied()
        .or_else(|| read_legacy_watermark(channel_id))
    {
        Some(w) => w,
        None => {
            if let Some(max) = parsed.posts.iter().map(|p| p.post_id).max() {
                watermarks.insert(channel_id.to_string(), max);
            }
            return Ok(());
        }
    };

    // A barrier post that has blocked delivery past the TTL is abandoned —
    // allow this pass to advance across it.
    let stale_barrier = stale_barrier_post_id(barriers.get(channel_id), now_ms);
    let (to_emit, new_watermark, blocking) =
        select_new_posts(parsed.posts, watermark, stale_barrier);

    if let Some(skipped) = stale_barrier.filter(|pid| new_watermark >= *pid) {
        channel_host::log(
            channel_host::LogLevel::Warn,
            &format!(
                "Clawbits poll: channel {}: skipping abandoned non-published post {} \
                 (blocked delivery for over {} min)",
                channel_id,
                skipped,
                STREAMING_BARRIER_TTL_MS / 60_000
            ),
        );
    }

    match next_barrier(barriers.get(channel_id).copied(), blocking, now_ms) {
        Some(rec) => {
            barriers.insert(channel_id.to_string(), rec);
        }
        None => {
            barriers.remove(channel_id);
        }
    }

    // Emit oldest-first so the agent sees posts in conversational order.
    for post in &to_emit {
        emit_post(post, self_agent_id, allow_from);
    }

    if new_watermark > watermark {
        watermarks.insert(channel_id.to_string(), new_watermark);
    }
    Ok(())
}

/// Select the contiguous run of *published* posts above the watermark, the new
/// watermark to persist, and the post (if any) now blocking further delivery.
///
/// Stops at the first non-published (streaming) post: a Clawbits post is created
/// `streaming` and later flips to `published` under the *same* `post_id`, so
/// advancing the watermark past a still-streaming post would lose it forever.
/// Everything at or after that barrier is re-evaluated on the next poll — except
/// `skip_stale`: a barrier post the caller has watched exceed
/// [`STREAMING_BARRIER_TTL_MS`] is treated as abandoned, and the scan advances
/// across it (accepting that a later flip of that one post is lost) so the rest
/// of the channel unfreezes. Note the watermark advances across terminal posts
/// the caller later drops (the agent's own posts, disallowed senders, empty
/// bodies) — they are still "seen", just not delivered.
fn select_new_posts(
    mut posts: Vec<MmPost>,
    watermark: i64,
    skip_stale: Option<i64>,
) -> (Vec<MmPost>, i64, Option<i64>) {
    posts.retain(|p| p.post_id > watermark);
    posts.sort_by_key(|p| p.post_id);

    let mut new_watermark = watermark;
    let mut out = Vec::new();
    let mut blocking = None;
    for post in posts {
        if post.status != "published" {
            if skip_stale == Some(post.post_id) {
                new_watermark = post.post_id;
                continue;
            }
            blocking = Some(post.post_id);
            break;
        }
        new_watermark = post.post_id;
        out.push(post);
    }
    (out, new_watermark, blocking)
}

/// The barrier post to skip this pass: the recorded blocker, once it has held
/// the channel for at least [`STREAMING_BARRIER_TTL_MS`].
fn stale_barrier_post_id(record: Option<&BarrierRecord>, now_ms: u64) -> Option<i64> {
    record
        .filter(|r| now_ms.saturating_sub(r.since_ms) >= STREAMING_BARRIER_TTL_MS)
        .map(|r| r.post_id)
}

/// Fold this pass's blocking post into the barrier record: no blocker clears
/// the record, the same blocker keeps its original clock (so the TTL measures
/// total blocked time, not time since the last poll), a new blocker restarts it.
fn next_barrier(
    prev: Option<BarrierRecord>,
    blocking: Option<i64>,
    now_ms: u64,
) -> Option<BarrierRecord> {
    let post_id = blocking?;
    match prev {
        Some(rec) if rec.post_id == post_id => Some(rec),
        _ => Some(BarrierRecord { post_id, since_ms: now_ms }),
    }
}

fn emit_post(post: &MmPost, self_agent_id: &str, allow_from: &[String]) {
    // Only fully-published posts are conversational turns; skip streaming/draft.
    if post.status != "published" {
        return;
    }
    // Skip the agent's own posts to avoid echo loops.
    if let Some(ref aid) = post.agent_id {
        if !self_agent_id.is_empty() && aid == self_agent_id {
            return;
        }
    }
    let sender = match sender_key(post) {
        Some(s) => s,
        None => return,
    };
    if !allow_from.is_empty() && !allow_from.iter().any(|a| a == &sender) {
        return;
    }
    let content = post.message.trim();
    // A post with neither text nor attachments carries nothing to react to;
    // file-only posts (empty text, files attached) DO flow through.
    if content.is_empty() && post.files.is_empty() {
        return;
    }

    let routing = ClawbitsRouting {
        channel_id: post.channel_id.clone(),
        post_id: post.post_id,
    };
    let metadata_json = serde_json::to_string(&routing).unwrap_or_else(|_| "{}".to_string());

    channel_host::emit_message(&EmittedMessage {
        user_id: sender,
        user_name: post.poster_display_name.clone(),
        content: content.to_string(),
        thread_id: Some(post.channel_id.clone()),
        metadata_json,
        attachments: post.files.iter().map(inbound_attachment).collect(),
    });
}

/// Map a post's file metadata onto the host's inbound-attachment record.
/// Images carry the inline presigned `download_url` as `source-url` (the host
/// can fetch it directly, unauthenticated); other types leave it unset — the
/// `file-id` is enough to resolve one later via `/api/agentic/mm/files/{id}/url`.
fn inbound_attachment(f: &MmFileInfo) -> InboundAttachment {
    let mut extras = serde_json::Map::new();
    if let Some(w) = f.width {
        extras.insert("width".into(), serde_json::json!(w));
    }
    if let Some(h) = f.height {
        extras.insert("height".into(), serde_json::json!(h));
    }
    InboundAttachment {
        id: f.file_id.clone(),
        mime_type: f
            .content_type
            .clone()
            .unwrap_or_else(|| "application/octet-stream".to_string()),
        filename: f.filename.clone(),
        size_bytes: f.size_bytes.and_then(|v| u64::try_from(v).ok()),
        source_url: f.download_url.clone(),
        storage_key: None,
        extracted_text: None,
        extras_json: serde_json::Value::Object(extras).to_string(),
    }
}

/// A stable identity for the post's author: `human:<id>` or `agent:<id>`.
fn sender_key(post: &MmPost) -> Option<String> {
    if let Some(hid) = post.human_id {
        return Some(format!("human:{}", hid));
    }
    if let Some(ref aid) = post.agent_id {
        return Some(format!("agent:{}", aid));
    }
    None
}

// ============================================================================
// Outbound posting
// ============================================================================

/// Server cap on attachments per post (MM_FILES_MAX_PER_POST default).
/// Overflow file_ids ride follow-up text-less posts.
const MAX_FILES_PER_POST: usize = 5;

/// Effective attachments-per-post cap: the operator's `max_files_per_post`
/// config value when set (persisted at activation), else the server default.
fn files_per_post() -> usize {
    read(MAX_FILES_PER_POST_PATH)
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(MAX_FILES_PER_POST)
}

fn post_message(channel_id: &str, content: &str, file_ids: &[String]) -> Result<(), String> {
    let endpoint = endpoint();
    let path = format!(
        "/api/agentic/mm/channels/{}/posts",
        encode_segment(channel_id)
    );
    let mut chunks = split_message(content, MAX_MESSAGE_LEN);
    // A file-only response still needs one post to carry the attachments.
    if chunks.is_empty() {
        if file_ids.is_empty() {
            return Ok(());
        }
        chunks = vec![String::new()];
    }
    let mut file_batches = file_ids.chunks(files_per_post());
    for chunk in &chunks {
        let mut body = serde_json::json!({ "message": chunk, "status": "published" });
        if let Some(batch) = file_batches.next() {
            body["file_ids"] = serde_json::json!(batch);
        }

        let mut resp = api_post(&endpoint, &path, &body)?;
        // Out of CB_TOKENS — mint more and retry once.
        if resp.status == 402 {
            mint_tokens(&endpoint)?;
            resp = api_post(&endpoint, &path, &body)?;
        }
        if !(200..300).contains(&resp.status) {
            let detail = String::from_utf8_lossy(&resp.body);
            return Err(format!("post returned {}: {}", resp.status, detail));
        }
        // Learn our own agent id from the post clawbits just created for us, so
        // the inbound poll can skip our own messages without configuration.
        learn_self_agent_id(&resp.body);
    }
    // More attachment batches than text chunks — flush the rest on
    // text-less posts so nothing is silently dropped.
    for batch in file_batches {
        let body = serde_json::json!({ "message": "", "status": "published", "file_ids": batch });
        let mut resp = api_post(&endpoint, &path, &body)?;
        if resp.status == 402 {
            mint_tokens(&endpoint)?;
            resp = api_post(&endpoint, &path, &body)?;
        }
        if !(200..300).contains(&resp.status) {
            let detail = String::from_utf8_lossy(&resp.body);
            return Err(format!("post returned {}: {}", resp.status, detail));
        }
    }
    Ok(())
}

/// Upload one outbound attachment through the server's *direct* byte route
/// and return its `file_id`. The direct route keeps the whole transfer on
/// the Clawbits API host — the WASM HTTP allowlist (`clawbits.capabilities
/// .json`) does not cover the R2 host a presigned PUT would need.
fn upload_attachment(
    endpoint: &str,
    channel_id: &str,
    filename: &str,
    mime_type: &str,
    data: &[u8],
) -> Result<String, String> {
    let url = format!(
        "{}/api/agentic/mm/channels/{}/files/direct?filename={}",
        endpoint,
        encode_segment(channel_id),
        encode_segment(filename)
    );
    let mime = if mime_type.is_empty() {
        "application/octet-stream"
    } else {
        mime_type
    };
    let headers = serde_json::json!({
        "Authorization": "Bearer {CLAWBITS_API_KEY}",
        "Content-Type": mime,
    })
    .to_string();
    let mut resp = channel_host::http_request("POST", &url, &headers, Some(data), None)?;
    // Same 402 → mint → retry-once dance as post_message.
    if resp.status == 402 {
        mint_tokens(endpoint)?;
        resp = channel_host::http_request("POST", &url, &headers, Some(data), None)?;
    }
    if !(200..300).contains(&resp.status) {
        let detail = String::from_utf8_lossy(&resp.body);
        return Err(format!("attachment upload returned {}: {}", resp.status, detail));
    }
    let parsed: serde_json::Value =
        serde_json::from_slice(&resp.body).map_err(|e| format!("parse upload response: {}", e))?;
    parsed
        .get("file_id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "upload response carried no file_id".to_string())
}

/// Upload every attachment on an agent response; failures degrade to a
/// warning line appended to the reply text rather than failing the whole
/// delivery (the text is the primary payload — losing it over a broken
/// image upload would be worse).
fn deliver_response(channel_id: &str, response: &AgentResponse) -> Result<(), String> {
    let endpoint = endpoint();
    let mut file_ids: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for att in &response.attachments {
        match upload_attachment(&endpoint, channel_id, &att.filename, &att.mime_type, &att.data) {
            Ok(id) => file_ids.push(id),
            Err(e) => failed.push(format!("{} ({})", att.filename, e)),
        }
    }
    let mut content = response.content.clone();
    if !failed.is_empty() {
        if !content.is_empty() {
            content.push('\n');
        }
        content.push_str(&format!(
            "⚠️ Couldn't deliver attachment(s): {}",
            failed.join(", ")
        ));
    }
    post_message(channel_id, &content, &file_ids)
}

/// Our agent id for own-post filtering: an explicit config value wins; otherwise
/// the id learned from a post we created. Empty when neither is known yet.
fn current_self_agent_id() -> String {
    configured_agent_id()
        .or_else(|| read(SELF_AGENT_ID_PATH).filter(|s| !s.is_empty()))
        .unwrap_or_default()
}

fn configured_agent_id() -> Option<String> {
    read(AGENT_ID_PATH).filter(|s| !s.is_empty())
}

/// If `agent_id` wasn't configured and isn't learned yet, persist the one
/// clawbits stamped on a post-create response.
fn learn_self_agent_id(post_response_body: &[u8]) {
    if configured_agent_id().is_some()
        || read(SELF_AGENT_ID_PATH).filter(|s| !s.is_empty()).is_some()
    {
        return;
    }
    if let Some(id) = parse_post_agent_id(post_response_body) {
        persist(SELF_AGENT_ID_PATH, &id);
    }
}

/// Extract a non-empty `agent_id` from a post-create response body.
fn parse_post_agent_id(body: &[u8]) -> Option<String> {
    serde_json::from_slice::<MmPost>(body)
        .ok()
        .and_then(|p| p.agent_id)
        .filter(|s| !s.is_empty())
}

// ============================================================================
// Auth / token minting (deterministic challenge)
// ============================================================================

/// Solve the Clawbits write-auth challenge and mint CB_TOKENS.
///
/// The server samples a question from a fixed pool; we answer from the bundled
/// [`known_answers`] table, retrying until we draw a question we know. A 401
/// signals a bad API key and aborts immediately.
///
/// Takes the endpoint explicitly rather than reading it via [`endpoint`]: on the
/// `on_start` mint path the freshly-`persist`ed endpoint is not yet readable back
/// (workspace writes commit at callback end), so a self-read would fall back to
/// [`DEFAULT_ENDPOINT`] and hit the wrong host.
fn mint_tokens(endpoint: &str) -> Result<(), String> {
    let mut last_err = String::from("no attempts made");
    for _ in 0..CHALLENGE_ATTEMPTS {
        let resp = api_get(endpoint, "/api/agentic/auth/challenge", Some(15_000))?;
        if resp.status == 401 {
            return Err("unauthorized (invalid API key)".to_string());
        }
        if resp.status != 200 {
            last_err = format!("challenge returned {}", resp.status);
            continue;
        }
        let challenge: ChallengeQuestion = serde_json::from_slice(&resp.body)
            .map_err(|e| format!("parse challenge: {}", e))?;

        let answer = match known_answers::answer_for(&challenge.challenge) {
            Some(a) => a,
            None => {
                last_err = format!("unknown challenge question: {}", challenge.challenge);
                continue;
            }
        };

        let body = serde_json::json!({
            "session_token": challenge.session_token,
            "challenge_response": answer,
        });
        let resp = api_post(endpoint, "/api/agentic/auth/challenge_response", &body)?;
        if resp.status == 401 {
            return Err("unauthorized (invalid API key)".to_string());
        }
        if (200..300).contains(&resp.status) {
            return Ok(());
        }
        last_err = format!("challenge_response returned {}", resp.status);
    }
    Err(format!(
        "token mint failed after {} attempts: {}",
        CHALLENGE_ATTEMPTS, last_err
    ))
}

// ============================================================================
// Liveness (POST /api/agentic/alive)
// ============================================================================

/// Ping only when the last successful ping is stale (or absent). Reads the
/// stamp persisted by the previous callback — within one callback the write
/// isn't readable back, which is fine: one ping per callback is the ceiling.
fn maybe_ping_alive(endpoint: &str, now_ms: u64) {
    let last = read(LAST_ALIVE_PATH).and_then(|s| s.parse::<u64>().ok());
    if alive_ping_due(last, now_ms) {
        ping_alive(endpoint, now_ms);
    }
}

/// Due when never pinged or the cadence has elapsed. Saturating: a stamp from
/// the future (clock skew across restarts) reads as "not due" rather than
/// underflowing.
fn alive_ping_due(last_ping_ms: Option<u64>, now_ms: u64) -> bool {
    match last_ping_ms {
        Some(last) => now_ms.saturating_sub(last) >= ALIVE_PING_INTERVAL_MS,
        None => true,
    }
}

/// The same liveness ping the OpenClaw plugin sends (see `mm_agent_alive`
/// server-side): bumps `last_alive_at` — what the status dot and the creation
/// wizard's ready gate key on — and self-reports the runtime kind in the body
/// plus the channel version in the `X-Clawbits-Plugin-Version` header for the
/// agent card. Failures only log: the next poll retries.
///
/// Takes the endpoint explicitly for the same reason [`mint_tokens`] does —
/// the `on_start` caller's persisted endpoint is not yet readable back.
fn ping_alive(endpoint: &str, now_ms: u64) {
    let url = format!("{}/api/agentic/alive", endpoint);
    let body = br#"{"agent_type":"ironclaw"}"#;
    match channel_host::http_request("POST", &url, &alive_headers(), Some(body), Some(10_000)) {
        Ok(resp) if (200..300).contains(&resp.status) => {
            persist(LAST_ALIVE_PATH, &now_ms.to_string());
        }
        Ok(resp) => channel_host::log(
            channel_host::LogLevel::Warn,
            &format!("Clawbits alive ping returned {}", resp.status),
        ),
        Err(e) => channel_host::log(
            channel_host::LogLevel::Warn,
            &format!("Clawbits alive ping failed: {}", e),
        ),
    }
}

/// [`api_headers`] plus the plugin-version header the alive endpoint folds
/// into the agent card (`parse_plugin_version` server-side).
fn alive_headers() -> String {
    serde_json::json!({
        "Authorization": "Bearer {CLAWBITS_API_KEY}",
        "Content-Type": "application/json",
        "X-Clawbits-Plugin-Version": env!("CARGO_PKG_VERSION"),
    })
    .to_string()
}

// ============================================================================
// HTTP helpers
// ============================================================================

/// The endpoint persisted by `on_start`. Valid in every callback *except*
/// `on_start` itself, where the write is not yet readable back — that path
/// passes the resolved endpoint explicitly instead of calling this.
fn endpoint() -> String {
    read(ENDPOINT_PATH)
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string())
}

fn api_get(endpoint: &str, path: &str, timeout_ms: Option<u32>) -> Result<HttpResponse, String> {
    let url = format!("{}{}", endpoint, path);
    let headers = api_headers(false);
    channel_host::http_request("GET", &url, &headers, None, timeout_ms)
}

fn api_post(endpoint: &str, path: &str, body: &serde_json::Value) -> Result<HttpResponse, String> {
    let url = format!("{}{}", endpoint, path);
    let headers = api_headers(true);
    let body_bytes = serde_json::to_vec(body).map_err(|e| format!("serialize body: {}", e))?;
    channel_host::http_request("POST", &url, &headers, Some(&body_bytes), None)
}

fn api_headers(json_body: bool) -> String {
    let mut headers = serde_json::json!({
        "Authorization": "Bearer {CLAWBITS_API_KEY}",
    });
    if json_body {
        headers["Content-Type"] = serde_json::json!("application/json");
    }
    headers.to_string()
}

// ============================================================================
// Status mapping
// ============================================================================

/// Map an IronClaw status to a Clawbits presence value, or `None` to skip.
fn classify_status(status: &StatusType) -> Option<&'static str> {
    match status {
        StatusType::Thinking | StatusType::ToolStarted | StatusType::ToolResult => Some("generating"),
        StatusType::Done | StatusType::Interrupted | StatusType::ToolCompleted => Some("online"),
        // Approval / job / auth transitions aren't presence changes.
        StatusType::Status
        | StatusType::ApprovalNeeded
        | StatusType::JobStarted
        | StatusType::AuthRequired
        | StatusType::AuthCompleted => None,
    }
}

// ============================================================================
// Helpers: workspace state, watermarks, message splitting, path encoding
// ============================================================================

fn read(path: &str) -> Option<String> {
    channel_host::workspace_read(path).filter(|s| !s.is_empty())
}

fn persist(path: &str, value: &str) {
    if let Err(e) = channel_host::workspace_write(path, value) {
        channel_host::log(
            channel_host::LogLevel::Error,
            &format!("Failed to persist {}: {}", path, e),
        );
    }
}

/// Load a `channel_id -> value` state map ([`WATERMARKS_PATH`] /
/// [`BARRIERS_PATH`]). Absent or unparsable state yields an empty map.
fn load_state_map<T: serde::de::DeserializeOwned>(path: &str) -> BTreeMap<String, T> {
    read(path)
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn persist_state_map<T: Serialize>(path: &str, map: &BTreeMap<String, T>) {
    match serde_json::to_string(map) {
        Ok(json) => persist(path, &json),
        Err(e) => channel_host::log(
            channel_host::LogLevel::Error,
            &format!("Failed to serialize {}: {}", path, e),
        ),
    }
}

/// Pre-map watermark layout: one `state/wm_<channel>` file per channel. Read
/// as a fallback so an upgrade doesn't replay or re-anchor; new writes land in
/// the [`WATERMARKS_PATH`] map only.
fn read_legacy_watermark(channel_id: &str) -> Option<i64> {
    read(&format!("state/wm_{}", sanitize_key(channel_id))).and_then(|s| s.parse::<i64>().ok())
}

/// Keep only filesystem-safe characters for a workspace state filename.
fn sanitize_key(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Percent-encode a single URL path segment (channel ids are typically safe,
/// but never interpolate untrusted ids raw).
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Split a reply into chunks within `limit` characters, preferring natural
/// boundaries. Operates on `char` counts and never slices mid-codepoint.
fn split_message(text: &str, limit: usize) -> Vec<String> {
    if text.chars().count() <= limit {
        return vec![text.to_string()];
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut remaining = text;

    while remaining.chars().count() > limit {
        // Byte index just past the `limit`-th char.
        let hard_end = remaining
            .char_indices()
            .nth(limit)
            .map(|(idx, _)| idx)
            .unwrap_or(remaining.len());
        let window = &remaining[..hard_end];

        // Prefer paragraph break, then newline, then sentence end, then space.
        let split_at = window
            .rfind("\n\n")
            .map(|i| i + 2)
            .or_else(|| window.rfind('\n').map(|i| i + 1))
            .or_else(|| window.rfind(". ").map(|i| i + 2))
            .or_else(|| window.rfind(' ').map(|i| i + 1))
            .unwrap_or(hard_end);

        let (head, tail) = remaining.split_at(split_at);
        let head = head.trim_end();
        if !head.is_empty() {
            chunks.push(head.to_string());
        }
        remaining = tail.trim_start();
    }

    if !remaining.is_empty() {
        chunks.push(remaining.to_string());
    }
    chunks
}

export!(ClawbitsChannel);

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn post(post_id: i64, agent: Option<&str>, human: Option<i64>, msg: &str, status: &str) -> MmPost {
        MmPost {
            post_id,
            channel_id: "ch_1".to_string(),
            agent_id: agent.map(|s| s.to_string()),
            human_id: human,
            poster_display_name: Some("Alice".to_string()),
            message: msg.to_string(),
            status: status.to_string(),
            files: Vec::new(),
        }
    }

    #[test]
    fn sender_key_prefers_human() {
        assert_eq!(sender_key(&post(1, Some("agent_x"), Some(42), "hi", "published")), Some("human:42".to_string()));
        assert_eq!(sender_key(&post(1, Some("agent_x"), None, "hi", "published")), Some("agent:agent_x".to_string()));
        assert_eq!(sender_key(&post(1, None, None, "hi", "published")), None);
    }

    #[test]
    fn routing_roundtrips() {
        let r = ClawbitsRouting { channel_id: "ch_9".to_string(), post_id: 7 };
        let j = serde_json::to_string(&r).unwrap();
        let back: ClawbitsRouting = serde_json::from_str(&j).unwrap();
        assert_eq!(back.channel_id, "ch_9");
        assert_eq!(back.post_id, 7);
    }

    #[test]
    fn challenge_response_field_alias() {
        // The server serializes `challenge_question` under the alias `challenge`.
        let wire = r#"{"session_token":"tok-agent_1","challenge":"What is the capital of France?"}"#;
        let parsed: ChallengeQuestion = serde_json::from_str(wire).unwrap();
        assert_eq!(parsed.session_token, "tok-agent_1");
        assert_eq!(known_answers::answer_for(&parsed.challenge), Some("PARIS"));
    }

    #[test]
    fn config_parses_max_files_per_post() {
        let wire = r#"{"endpoint":"https://fc.test","max_files_per_post":3}"#;
        let parsed: ClawbitsConfig = serde_json::from_str(wire).unwrap();
        assert_eq!(parsed.max_files_per_post, Some(3));

        // Omitted → None → post_message falls back to the server default (5).
        let minimal: ClawbitsConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(minimal.max_files_per_post, None);
    }

    #[test]
    fn post_list_parses_minimal_fields() {
        let wire = r#"{"posts":[{"post_id":5,"channel_id":"ch_1","human_id":3,"message":"hello","created_at":"2026-01-01T00:00:00Z","status":"published","extra":"ignored"}],"total":1}"#;
        let parsed: MmPostListResponse = serde_json::from_str(wire).unwrap();
        assert_eq!(parsed.posts.len(), 1);
        assert_eq!(parsed.posts[0].post_id, 5);
        assert_eq!(parsed.posts[0].human_id, Some(3));
        assert_eq!(parsed.posts[0].message, "hello");
    }

    #[test]
    fn learns_agent_id_from_post_response() {
        // A post-create response carries our own agent_id; we extract it to
        // filter our own posts without the operator configuring agent_id.
        let wire = br#"{"post_id":42,"channel_id":"ch_1","agent_id":"agent_self","message":"hi","created_at":"2026-01-01T00:00:00Z","status":"published"}"#;
        assert_eq!(parse_post_agent_id(wire), Some("agent_self".to_string()));
        // A human-authored post (no agent_id) yields nothing to learn.
        let human = br#"{"post_id":43,"channel_id":"ch_1","human_id":7,"message":"hi","created_at":"2026-01-01T00:00:00Z","status":"published"}"#;
        assert_eq!(parse_post_agent_id(human), None);
    }

    #[test]
    fn split_short_message_is_single_chunk() {
        assert_eq!(split_message("hello", 4000), vec!["hello".to_string()]);
    }

    #[test]
    fn split_long_message_respects_char_limit() {
        let text = "a".repeat(9001);
        let chunks = split_message(&text, 4000);
        assert!(chunks.len() >= 3);
        for c in &chunks {
            assert!(c.chars().count() <= 4000, "chunk exceeds limit: {}", c.chars().count());
        }
        assert_eq!(chunks.concat().chars().count(), 9001);
    }

    #[test]
    fn split_is_utf8_safe_on_multibyte() {
        // 5000 multi-byte chars must never panic and never exceed the char limit.
        let text = "é".repeat(5000);
        let chunks = split_message(&text, 4000);
        for c in &chunks {
            assert!(c.chars().count() <= 4000);
        }
    }

    #[test]
    fn sanitize_key_strips_unsafe_chars() {
        assert_eq!(sanitize_key("ch/../etc"), "ch____etc");
        assert_eq!(sanitize_key("ch_ABC-123"), "ch_ABC-123");
    }

    #[test]
    fn api_headers_include_env_placeholder_auth() {
        let get: serde_json::Value = serde_json::from_str(&api_headers(false)).unwrap();
        assert_eq!(get["Authorization"], "Bearer {CLAWBITS_API_KEY}");
        assert!(get.get("Content-Type").is_none());

        let post: serde_json::Value = serde_json::from_str(&api_headers(true)).unwrap();
        assert_eq!(post["Authorization"], "Bearer {CLAWBITS_API_KEY}");
        assert_eq!(post["Content-Type"], "application/json");
    }

    #[test]
    fn alive_headers_carry_auth_and_channel_version() {
        let h: serde_json::Value = serde_json::from_str(&alive_headers()).unwrap();
        assert_eq!(h["Authorization"], "Bearer {CLAWBITS_API_KEY}");
        assert_eq!(h["Content-Type"], "application/json");
        assert_eq!(h["X-Clawbits-Plugin-Version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn alive_ping_due_on_first_run_then_only_after_cadence() {
        let now = 1_000_000_000_u64;
        // Never pinged -> due (the "on startup" half of the cadence).
        assert!(alive_ping_due(None, now));
        // Fresh ping -> not due.
        assert!(!alive_ping_due(Some(now), now));
        assert!(!alive_ping_due(Some(now - ALIVE_PING_INTERVAL_MS + 1), now));
        // Cadence elapsed -> due.
        assert!(alive_ping_due(Some(now - ALIVE_PING_INTERVAL_MS), now));
        // A stamp from the future (clock skew) must not underflow into "due".
        assert!(!alive_ping_due(Some(now + 60_000), now));
    }

    #[test]
    fn select_skips_seen_and_orders_ascending() {
        let posts = vec![
            post(12, None, Some(1), "c", "published"),
            post(10, None, Some(1), "a", "published"),
            post(11, None, Some(1), "b", "published"),
        ];
        let (out, wm, blocking) = select_new_posts(posts, 10, None);
        assert_eq!(out.iter().map(|p| p.post_id).collect::<Vec<_>>(), vec![11, 12]);
        assert_eq!(wm, 12);
        assert_eq!(blocking, None);
    }

    #[test]
    fn select_stops_at_streaming_barrier() {
        // 11 is still streaming; 12 is published but sits *after* the barrier.
        // We must emit only 11-and-before-published (none here past wm 10),
        // and NOT advance the watermark past the streaming post — otherwise 11
        // is lost when it finalizes to published under the same post_id.
        let posts = vec![
            post(11, Some("other"), None, "", "streaming"),
            post(12, None, Some(1), "later", "published"),
        ];
        let (out, wm, blocking) = select_new_posts(posts, 10, None);
        assert!(out.is_empty(), "nothing before the barrier should emit");
        assert_eq!(wm, 10, "watermark must not advance past a streaming post");
        assert_eq!(blocking, Some(11), "the blocking post must be reported");
    }

    #[test]
    fn select_emits_published_prefix_before_barrier() {
        let posts = vec![
            post(11, None, Some(1), "ready", "published"),
            post(12, Some("other"), None, "", "streaming"),
            post(13, None, Some(1), "after", "published"),
        ];
        let (out, wm, blocking) = select_new_posts(posts, 10, None);
        assert_eq!(out.iter().map(|p| p.post_id).collect::<Vec<_>>(), vec![11]);
        assert_eq!(wm, 11, "advance only across the published prefix");
        assert_eq!(blocking, Some(12));
    }

    #[test]
    fn select_skips_stale_barrier_and_resumes_delivery() {
        // 11 was abandoned mid-stream (caller determined it exceeded the TTL):
        // the scan advances across it and delivers 12/13 — the freeze ends.
        let posts = vec![
            post(11, Some("other"), None, "", "streaming"),
            post(12, None, Some(1), "unblocked", "published"),
            post(13, None, Some(1), "also", "published"),
        ];
        let (out, wm, blocking) = select_new_posts(posts, 10, Some(11));
        assert_eq!(out.iter().map(|p| p.post_id).collect::<Vec<_>>(), vec![12, 13]);
        assert_eq!(wm, 13);
        assert_eq!(blocking, None);
    }

    #[test]
    fn select_skip_applies_only_to_the_recorded_post() {
        // The stale skip is pinned to post 11; a *different* streaming post
        // further on (14) still blocks — its own TTL clock starts fresh.
        let posts = vec![
            post(11, Some("other"), None, "", "streaming"),
            post(12, None, Some(1), "ok", "published"),
            post(14, Some("third"), None, "", "streaming"),
            post(15, None, Some(1), "held", "published"),
        ];
        let (out, wm, blocking) = select_new_posts(posts, 10, Some(11));
        assert_eq!(out.iter().map(|p| p.post_id).collect::<Vec<_>>(), vec![12]);
        assert_eq!(wm, 12);
        assert_eq!(blocking, Some(14));
    }

    #[test]
    fn barrier_becomes_stale_only_after_ttl() {
        let rec = BarrierRecord { post_id: 11, since_ms: 1_000 };
        assert_eq!(stale_barrier_post_id(Some(&rec), 1_000), None, "fresh");
        assert_eq!(
            stale_barrier_post_id(Some(&rec), 1_000 + STREAMING_BARRIER_TTL_MS - 1),
            None,
            "one tick short of the TTL"
        );
        assert_eq!(
            stale_barrier_post_id(Some(&rec), 1_000 + STREAMING_BARRIER_TTL_MS),
            Some(11),
            "at the TTL the blocker is abandoned"
        );
        assert_eq!(stale_barrier_post_id(None, u64::MAX), None, "no record");
    }

    #[test]
    fn barrier_record_keeps_clock_for_same_post_and_resets_for_new() {
        let first = next_barrier(None, Some(11), 1_000).unwrap();
        assert_eq!(first, BarrierRecord { post_id: 11, since_ms: 1_000 });

        // Same post still blocking later: the original clock is kept so the
        // TTL measures total blocked time, not time since the last poll.
        let held = next_barrier(Some(first), Some(11), 5_000).unwrap();
        assert_eq!(held.since_ms, 1_000);

        // A different post takes over the barrier: clock restarts.
        let switched = next_barrier(Some(held), Some(14), 9_000).unwrap();
        assert_eq!(switched, BarrierRecord { post_id: 14, since_ms: 9_000 });

        // Nothing blocking clears the record.
        assert_eq!(next_barrier(Some(switched), None, 9_500), None);
    }

    #[test]
    fn state_maps_roundtrip_through_json() {
        // The exact wire shape the workspace stores — a regression here would
        // orphan persisted watermarks on upgrade.
        let mut wm: BTreeMap<String, i64> = BTreeMap::new();
        wm.insert("ch_1".to_string(), 42);
        let json = serde_json::to_string(&wm).unwrap();
        assert_eq!(json, r#"{"ch_1":42}"#);
        let back: BTreeMap<String, i64> = serde_json::from_str(&json).unwrap();
        assert_eq!(back.get("ch_1"), Some(&42));

        let mut barriers: BTreeMap<String, BarrierRecord> = BTreeMap::new();
        barriers.insert("ch_1".to_string(), BarrierRecord { post_id: 11, since_ms: 7 });
        let json = serde_json::to_string(&barriers).unwrap();
        assert_eq!(json, r#"{"ch_1":{"post_id":11,"since_ms":7}}"#);
        let back: BTreeMap<String, BarrierRecord> = serde_json::from_str(&json).unwrap();
        assert_eq!(back.get("ch_1"), Some(&BarrierRecord { post_id: 11, since_ms: 7 }));
    }

    #[test]
    fn status_mapping() {
        assert_eq!(classify_status(&StatusType::Thinking), Some("generating"));
        assert_eq!(classify_status(&StatusType::Done), Some("online"));
        assert_eq!(classify_status(&StatusType::Status), None);
    }
}
