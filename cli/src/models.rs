//! Wire types, mirroring the Pydantic models in
//! `clawbits/datastructures/mm_models.py` and the hand-built dicts in
//! `clawbits/fastapi/human_endpoints.py`.
//!
//! # Two rules, both load-bearing
//!
//! **Never `deny_unknown_fields`.** The server grows fields — `avatar`,
//! `unread_mention_count`, `link_preview` and `last_message_attachment_count`
//! are all recent additions — and a strict client would break on each one. A
//! test in this module encodes that.
//!
//! **Only the fields Pydantic actually requires are required here.** Everything
//! with a default upstream carries `#[serde(default)]`, so a response that
//! predates a field still parses. The genuinely-required set stays required so
//! a wholly wrong payload is an error rather than a struct full of zeroes.
//!
//! Some fields here are not read by any renderer today. They stay because this
//! module's job is to state the wire contract — including which fields the
//! server guarantees, which is what makes the required/optional split above
//! meaningful and testable. Hence:
#![allow(dead_code)]

use serde::Deserialize;

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

/// `MeResponse` / `DevLoginResponse`. `token` is populated by the two login
/// endpoints and null on `GET /api/auth/me`.
#[derive(Debug, Clone, Deserialize)]
pub struct Me {
    pub id: i64,
    pub email: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub last_seen_at: Option<String>,
}

impl Me {
    /// What to call this person in output.
    pub fn label(&self) -> &str {
        self.display_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.email)
    }
}

// ---------------------------------------------------------------------------
// orgs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct Org {
    pub org_id: String,
    pub name: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub is_personal: bool,
    #[serde(default)]
    pub my_role: Option<String>,
    #[serde(default)]
    pub unread_count: i64,
    #[serde(default)]
    pub unread_channel_count: i64,
    #[serde(default)]
    pub created_at: Option<String>,
}

impl Org {
    pub fn label(&self) -> &str {
        self.display_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.name)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct OrgList {
    #[serde(default)]
    pub organizations: Vec<Org>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OrgMember {
    pub human_id: i64,
    pub email: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OrgMemberList {
    #[serde(default)]
    pub members: Vec<OrgMember>,
}

/// One entry of `GET /api/human/orgs/{org_id}/agents`. That handler has no
/// `response_model` and assembles dicts by hand, so this is modelled loosely:
/// only what the CLI renders or gates on.
#[derive(Debug, Clone, Deserialize)]
pub struct Agent {
    pub agent_id: String,
    #[serde(default)]
    pub nickname: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Contact is closed by default; without this a DM is a 403.
    #[serde(default)]
    pub can_dm: bool,
    #[serde(default)]
    pub can_tag: bool,
}

impl Agent {
    pub fn label(&self) -> &str {
        self.nickname
            .as_deref()
            .or(self.display_name.as_deref())
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.agent_id)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentList {
    #[serde(default)]
    pub agents: Vec<Agent>,
}

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct Channel {
    pub channel_id: String,
    pub name: String,
    pub channel_type: String,
    #[serde(default)]
    pub org_id: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub private: bool,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub last_message_at: Option<String>,
    #[serde(default)]
    pub unread_count: i64,
    #[serde(default)]
    pub unread_mention_count: i64,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub last_message_text: Option<String>,
    #[serde(default)]
    pub last_message_author_display_name: Option<String>,
    #[serde(default)]
    pub last_message_attachment_count: i64,
    #[serde(default)]
    pub dm_peer_human_id: Option<i64>,
    #[serde(default)]
    pub dm_peer_agent_id: Option<String>,
}

impl Channel {
    pub fn is_dm(&self) -> bool {
        self.channel_type == "direct"
    }

    /// What to show in a list. DMs are named after the peer; the server
    /// already substitutes the peer's name into `display_name`, so this only
    /// has to pick a non-empty one and skip the `#` for DMs.
    pub fn label(&self) -> String {
        let base = self
            .display_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.name);
        if self.is_dm() {
            base.to_string()
        } else {
            format!("#{base}")
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChannelList {
    #[serde(default)]
    pub channels: Vec<Channel>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChannelMember {
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub human_id: Option<i64>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub joined_at: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChannelMemberList {
    #[serde(default)]
    pub members: Vec<ChannelMember>,
}

// ---------------------------------------------------------------------------
// posts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct Post {
    pub post_id: i64,
    pub channel_id: String,
    pub message: String,
    pub created_at: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub human_id: Option<i64>,
    #[serde(default)]
    pub poster_display_name: Option<String>,
    #[serde(default = "published")]
    pub status: String,
    #[serde(default)]
    pub edited_at: Option<String>,
    #[serde(default)]
    pub pinned_at: Option<String>,
    #[serde(default)]
    pub parent_post_id: Option<i64>,
    #[serde(default)]
    pub parent_preview: Option<ParentPreview>,
    #[serde(default)]
    pub reactions: Vec<ReactionAggregate>,
    #[serde(default)]
    pub files: Vec<FileRef>,
}

fn published() -> String {
    "published".to_string()
}

impl Post {
    pub fn author(&self) -> String {
        if let Some(name) = self
            .poster_display_name
            .as_deref()
            .filter(|s| !s.is_empty())
        {
            return name.to_string();
        }
        if let Some(agent) = &self.agent_id {
            return agent.clone();
        }
        match self.human_id {
            Some(id) => format!("user {id}"),
            None => "unknown".to_string(),
        }
    }

    pub fn is_edited(&self) -> bool {
        self.edited_at.is_some()
    }

    pub fn is_pinned(&self) -> bool {
        self.pinned_at.is_some()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ParentPreview {
    pub post_id: i64,
    #[serde(default)]
    pub poster_display_name: Option<String>,
    #[serde(default)]
    pub message_excerpt: String,
    #[serde(default = "published")]
    pub status: String,
    #[serde(default)]
    pub attachment_count: i64,
}

impl ParentPreview {
    /// The one-line quote under a reply.
    ///
    /// A post may legitimately carry files and no text, so "no excerpt" is not
    /// the same as "blank message" — saying `(empty message)` for an
    /// attachment-only parent would be a lie.
    pub fn excerpt(&self) -> String {
        if self.status == "rejected" {
            return "original message removed".to_string();
        }
        let text = self.message_excerpt.trim();
        if !text.is_empty() {
            return text.replace('\n', " ");
        }
        match self.attachment_count {
            0 => "(empty message)".to_string(),
            1 => "(attachment)".to_string(),
            n => format!("({n} attachments)"),
        }
    }

    pub fn author(&self) -> &str {
        self.poster_display_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("someone")
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReactionAggregate {
    pub emoji: String,
    #[serde(default)]
    pub count: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileRef {
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PostList {
    #[serde(default)]
    pub posts: Vec<Post>,
    // `total` is deliberately not modelled: the server sets it to len(posts),
    // so reading it as a collection size would silently break pagination.
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct SearchAuthor {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub human_id: Option<i64>,
}

impl SearchAuthor {
    pub fn label(&self) -> String {
        if let Some(name) = self.display_name.as_deref().filter(|s| !s.is_empty()) {
            return name.to_string();
        }
        if let Some(agent) = &self.agent_id {
            return agent.clone();
        }
        match self.human_id {
            Some(id) => format!("user {id}"),
            None => "unknown".to_string(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchResult {
    pub post_id: i64,
    pub channel_id: String,
    pub created_at: String,
    #[serde(default)]
    pub channel_display_name: Option<String>,
    #[serde(default)]
    pub channel_type: Option<String>,
    #[serde(default)]
    pub author: Option<SearchAuthor>,
    #[serde(default)]
    pub snippet: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchResponse {
    #[serde(default)]
    pub results: Vec<SearchResult>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// If you are here because you added `deny_unknown_fields`: don't. The
    /// server adds response fields routinely and a strict client turns each
    /// one into a release-day outage.
    #[test]
    fn unknown_fields_are_tolerated_everywhere() {
        let post: Post = serde_json::from_str(
            r#"{"post_id":1,"channel_id":"c","message":"hi","created_at":"2026-08-14 09:12:33",
                "some_field_added_next_quarter":{"nested":true}}"#,
        )
        .expect("a new server field must not break an older client");
        assert_eq!(post.post_id, 1);

        let channel: Channel = serde_json::from_str(
            r#"{"channel_id":"c","name":"general","channel_type":"public","brand_new":1}"#,
        )
        .unwrap();
        assert_eq!(channel.name, "general");

        let me: Me =
            serde_json::from_str(r#"{"id":7,"email":"a@b.c","display_name":null,"whatever":1}"#)
                .unwrap();
        assert_eq!(me.id, 7);
    }

    /// The mirror of the above: everything Pydantic gives a default must be
    /// optional here, so a lean payload still deserializes.
    #[test]
    fn only_the_pydantic_required_fields_are_required() {
        let post: Post = serde_json::from_str(
            r#"{"post_id":42,"channel_id":"c_1","message":"hello","created_at":"2026-08-14 09:12:33"}"#,
        )
        .unwrap();
        assert_eq!(post.status, "published");
        assert!(post.reactions.is_empty());
        assert!(post.files.is_empty());
        assert!(post.parent_preview.is_none());

        let channel: Channel =
            serde_json::from_str(r#"{"channel_id":"c","name":"g","channel_type":"public"}"#)
                .unwrap();
        assert_eq!(channel.unread_count, 0);
        assert!(!channel.muted);
        assert!(!channel.pinned);
    }

    #[test]
    fn a_genuinely_wrong_payload_is_still_an_error() {
        // Leniency has a floor: this must not deserialize into zeroes.
        assert!(serde_json::from_str::<Post>(r#"{"nothing":"useful"}"#).is_err());
        assert!(serde_json::from_str::<Channel>(r#"{"channel_id":"c"}"#).is_err());
    }

    #[test]
    fn author_falls_back_through_the_identity_fields() {
        let base = r#""channel_id":"c","message":"m","created_at":"t","post_id":1"#;
        let named: Post =
            serde_json::from_str(&format!(r#"{{{base},"poster_display_name":"alice"}}"#)).unwrap();
        assert_eq!(named.author(), "alice");

        let agent: Post = serde_json::from_str(&format!(r#"{{{base},"agent_id":"a_7"}}"#)).unwrap();
        assert_eq!(agent.author(), "a_7");

        let human: Post = serde_json::from_str(&format!(r#"{{{base},"human_id":9}}"#)).unwrap();
        assert_eq!(human.author(), "user 9");

        let anon: Post = serde_json::from_str(&format!(r#"{{{base}}}"#)).unwrap();
        assert_eq!(anon.author(), "unknown");

        // An empty display name must not win over a real id.
        let blank: Post = serde_json::from_str(&format!(
            r#"{{{base},"poster_display_name":"","agent_id":"a"}}"#
        ))
        .unwrap();
        assert_eq!(blank.author(), "a");
    }

    #[test]
    fn channel_labels_distinguish_dms_from_channels() {
        let public: Channel =
            serde_json::from_str(r#"{"channel_id":"c","name":"general","channel_type":"public"}"#)
                .unwrap();
        assert_eq!(public.label(), "#general");

        let dm: Channel = serde_json::from_str(
            r#"{"channel_id":"c","name":"dm-x","channel_type":"direct","display_name":"alice"}"#,
        )
        .unwrap();
        assert_eq!(dm.label(), "alice");
        assert!(dm.is_dm());
    }

    #[test]
    fn quote_excerpt_distinguishes_blank_from_attachment_only() {
        let mk = |json: &str| serde_json::from_str::<ParentPreview>(json).unwrap();

        assert_eq!(
            mk(r#"{"post_id":1,"message_excerpt":"hello there"}"#).excerpt(),
            "hello there"
        );
        assert_eq!(
            mk(r#"{"post_id":1,"message_excerpt":""}"#).excerpt(),
            "(empty message)"
        );
        assert_eq!(
            mk(r#"{"post_id":1,"message_excerpt":"","attachment_count":1}"#).excerpt(),
            "(attachment)"
        );
        assert_eq!(
            mk(r#"{"post_id":1,"message_excerpt":"","attachment_count":3}"#).excerpt(),
            "(3 attachments)"
        );
        assert_eq!(
            mk(r#"{"post_id":1,"message_excerpt":"gone","status":"rejected"}"#).excerpt(),
            "original message removed"
        );
        // Newlines would break the single-line quote layout.
        assert_eq!(
            mk(r#"{"post_id":1,"message_excerpt":"a\nb"}"#).excerpt(),
            "a b"
        );
    }
}
