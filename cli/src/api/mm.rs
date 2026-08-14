//! `/api/human/mm/*` — channels, posts, DMs, search.
//!
//! Path and query construction live in free functions so they can be tested
//! without a server; the `*_query` builders return owned pairs because that is
//! what [`Client::request`] takes.

use serde_json::{json, Value};

use super::{encode_segment, ApiError, Client, Method};
use crate::models::ChannelList;

/// The server's own cap on a single message.
pub const MAX_MESSAGE_CHARS: usize = 4000;

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

pub fn channel_path(channel_id: &str, suffix: &str) -> String {
    format!(
        "/api/human/mm/channels/{}{}",
        encode_segment(channel_id),
        suffix
    )
}

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

/// Omitting `org_id` is meaningful: it returns every channel across every org,
/// which is what `channels --all-orgs` wants.
pub fn channels_query(org_id: Option<&str>) -> Vec<(&'static str, String)> {
    match org_id {
        Some(id) => vec![("org_id", id.to_string())],
        None => Vec::new(),
    }
}

pub fn posts_query(
    limit: u32,
    before: Option<i64>,
    after: Option<i64>,
) -> Vec<(&'static str, String)> {
    let mut q = vec![("limit", limit.to_string())];
    if let Some(id) = before {
        q.push(("before_post_id", id.to_string()));
    }
    if let Some(id) = after {
        q.push(("after_post_id", id.to_string()));
    }
    q
}

#[derive(Debug, Default, Clone)]
pub struct SearchParams<'a> {
    pub q: &'a str,
    pub org_id: Option<&'a str>,
    pub channel_id: Option<&'a str>,
    pub sort: &'a str,
    pub limit: u32,
    pub cursor: Option<&'a str>,
    pub from_human_id: Option<i64>,
    pub from_agent_id: Option<&'a str>,
    pub before: Option<&'a str>,
    pub after: Option<&'a str>,
    pub has_link: bool,
    pub has_file: bool,
}

pub fn search_query(p: &SearchParams<'_>) -> Vec<(&'static str, String)> {
    let mut q = vec![
        ("q", p.q.to_string()),
        ("sort", p.sort.to_string()),
        ("limit", p.limit.to_string()),
    ];
    if let Some(v) = p.org_id {
        q.push(("org_id", v.to_string()));
    }
    if let Some(v) = p.channel_id {
        q.push(("channel_id", v.to_string()));
    }
    if let Some(v) = p.cursor {
        q.push(("cursor", v.to_string()));
    }
    if let Some(v) = p.from_human_id {
        q.push(("from_human_id", v.to_string()));
    }
    if let Some(v) = p.from_agent_id {
        q.push(("from_agent_id", v.to_string()));
    }
    if let Some(v) = p.before {
        q.push(("before", v.to_string()));
    }
    if let Some(v) = p.after {
        q.push(("after", v.to_string()));
    }
    // Only send the booleans when true — they default to false server-side and
    // sending `false` just makes the URL noisier in --verbose output.
    if p.has_link {
        q.push(("has_link", "true".to_string()));
    }
    if p.has_file {
        q.push(("has_file", "true".to_string()));
    }
    q
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

/// The one channel-list fetch.
///
/// Returns the raw `Value` because `--json` must be able to print exactly what
/// the server sent, including fields this binary doesn't model. Callers that
/// want the typed view go through [`channels`].
pub fn channels_raw(client: &Client, org_id: Option<&str>) -> Result<Value, ApiError> {
    client.request(
        Method::Get,
        "/api/human/mm/channels",
        &channels_query(org_id),
        None,
    )
}

pub fn channels(client: &Client, org_id: Option<&str>) -> Result<ChannelList, ApiError> {
    let value = channels_raw(client, org_id)?;
    serde_json::from_value(value).map_err(|source| ApiError::Decode {
        path: "/api/human/mm/channels".to_string(),
        source,
    })
}

pub fn mark_read(client: &Client, channel_id: &str, post_id: i64) -> Result<(), ApiError> {
    client.post(
        &channel_path(channel_id, "/read"),
        &json!({ "post_id": post_id }),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys<'a>(q: &'a [(&'a str, String)]) -> Vec<&'a str> {
        q.iter().map(|(k, _)| *k).collect()
    }

    #[test]
    fn channel_paths_encode_the_id() {
        assert_eq!(
            channel_path("c_abc", "/posts"),
            "/api/human/mm/channels/c_abc/posts"
        );
        assert_eq!(
            channel_path("a/b", "/read"),
            "/api/human/mm/channels/a%2Fb/read"
        );
    }

    #[test]
    fn all_orgs_means_sending_no_org_id_at_all() {
        assert!(channels_query(None).is_empty());
        assert_eq!(
            channels_query(Some("org_1")),
            vec![("org_id", "org_1".to_string())]
        );
    }

    #[test]
    fn post_cursors_are_omitted_when_unset() {
        assert_eq!(keys(&posts_query(50, None, None)), vec!["limit"]);
        assert_eq!(
            keys(&posts_query(50, Some(10), None)),
            vec!["limit", "before_post_id"]
        );
        assert_eq!(
            keys(&posts_query(50, None, Some(10))),
            vec!["limit", "after_post_id"]
        );
    }

    #[test]
    fn search_omits_empty_filters_and_false_flags() {
        let p = SearchParams {
            q: "deploy",
            sort: "recent",
            limit: 25,
            ..Default::default()
        };
        assert_eq!(keys(&search_query(&p)), vec!["q", "sort", "limit"]);
    }

    #[test]
    fn search_includes_the_filters_it_is_given() {
        let p = SearchParams {
            q: "deploy",
            org_id: Some("org_1"),
            channel_id: Some("c_1"),
            sort: "relevant",
            limit: 10,
            cursor: Some("eyJ4IjoxfQ=="),
            from_human_id: Some(7),
            before: Some("2026-08-01"),
            has_file: true,
            ..Default::default()
        };
        let q = search_query(&p);
        assert_eq!(
            keys(&q),
            vec![
                "q",
                "sort",
                "limit",
                "org_id",
                "channel_id",
                "cursor",
                "from_human_id",
                "before",
                "has_file"
            ]
        );
        // The cursor is opaque and must survive verbatim.
        let cursor = q.iter().find(|(k, _)| *k == "cursor").unwrap();
        assert_eq!(cursor.1, "eyJ4IjoxfQ==");
    }
}
