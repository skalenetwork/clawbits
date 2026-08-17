//! Rendering a channel as a chat log.
//!
//! The server returns posts newest-first. A terminal transcript reads
//! top-to-bottom, so [`render`] expects them **oldest-first** — the caller
//! reverses. That is deliberate: pagination wants the server's order, reading
//! wants the other one, and putting the flip in one obvious place beats
//! discovering it twice.

use super::list::{human_size, truncate, visible_width};
use super::style::Style;
use super::time;
use crate::models::Post;

/// Author column bounds. Narrow enough that the message column starts in a
/// predictable place, wide enough that most names survive intact.
const AUTHOR_MIN: usize = 8;
const AUTHOR_MAX: usize = 16;

pub fn render(posts: &[Post], header: Option<&str>, style: &Style) -> String {
    let mut out = String::new();

    if let Some(h) = header {
        out.push_str(&style.bold(h));
        out.push('\n');
        out.push_str(&style.dim(&style.rule(visible_width(h).clamp(20, 60))));
        out.push('\n');
    }

    if posts.is_empty() {
        out.push_str(&style.dim("(no messages)"));
        out.push('\n');
        return out;
    }

    let author_width = posts
        .iter()
        .map(|p| visible_width(&p.author()))
        .max()
        .unwrap_or(AUTHOR_MIN)
        .clamp(AUTHOR_MIN, AUTHOR_MAX);

    // " HH:MM  " + author + "  "
    let indent = " ".repeat(1 + 5 + 2 + author_width + 2);
    let mut current_day: Option<String> = None;

    for post in posts {
        let day = time::local_day(&post.created_at);
        if day != current_day {
            if current_day.is_some() {
                out.push('\n');
            }
            out.push_str(&style.dim(&time::date_header(&post.created_at)));
            out.push('\n');
            current_day = day;
        }

        let prefix = format!(
            " {}  {}  ",
            style.dim(&time::clock(&post.created_at)),
            style.author(&super::list::pad(
                &truncate(&post.author(), author_width),
                author_width
            )),
        );

        // The quote block, when this is a reply, takes the prefix line and
        // pushes the message down — the same shape the web client uses.
        let mut first_line_used = false;
        if let Some(parent) = &post.parent_preview {
            let arrow = style.glyph("↳", ">");
            let quote = format!(
                "{arrow} {}: \"{}\"",
                parent.author(),
                truncate(&parent.excerpt(), 60)
            );
            out.push_str(&prefix);
            out.push_str(&style.dim(&quote));
            out.push('\n');
            first_line_used = true;
        }

        let markers = markers(post, style);
        let body: Vec<&str> = if post.message.is_empty() {
            vec![]
        } else {
            post.message.lines().collect()
        };

        if body.is_empty() {
            // Attachment-only posts are legal; don't render a blank row.
            let line = format!("{}{}", style.dim("(no text)"), markers);
            emit(&mut out, &prefix, &indent, &mut first_line_used, &line);
        } else {
            let last = body.len() - 1;
            for (i, raw) in body.iter().enumerate() {
                let line = if i == last {
                    format!("{raw}{markers}")
                } else {
                    (*raw).to_string()
                };
                emit(&mut out, &prefix, &indent, &mut first_line_used, &line);
            }
        }

        for file in &post.files {
            let clip = style.glyph("📎", "[file]");
            out.push_str(&indent);
            out.push_str(&style.dim(&format!(
                "{clip} {} ({})",
                file.filename,
                human_size(file.size_bytes)
            )));
            out.push('\n');
        }

        if !post.reactions.is_empty() {
            let line = post
                .reactions
                .iter()
                .map(|r| format!("{} {}", r.emoji, r.count))
                .collect::<Vec<_>>()
                .join("  ");
            out.push_str(&indent);
            out.push_str(&style.dim(&line));
            out.push('\n');
        }
    }

    out
}

/// First body line goes on the prefix line unless a quote already claimed it.
fn emit(out: &mut String, prefix: &str, indent: &str, first_used: &mut bool, line: &str) {
    if *first_used {
        out.push_str(indent);
    } else {
        out.push_str(prefix);
        *first_used = true;
    }
    out.push_str(line);
    out.push('\n');
}

/// The trailing annotations: post id, edited/pinned marks, and a status tag for
/// anything that isn't a normal published message.
///
/// The post id is always shown. Every other command — `--reply-to`, `--before`,
/// `--after`, `--thread` — consumes one, so hiding it would make the transcript
/// a dead end.
fn markers(post: &Post, style: &Style) -> String {
    let mut parts = Vec::new();
    if post.is_edited() {
        parts.push(style.dim("(edited)"));
    }
    if post.is_pinned() {
        parts.push(style.glyph("📌", "[pinned]"));
    }
    // list_posts can return drafts, streaming placeholders and rejected posts.
    // Without a tag they read as ordinary messages.
    if post.status != "published" {
        parts.push(style.dim(&format!("[{}]", post.status)));
    }
    parts.push(style.dim(&format!("[{}]", post.post_id)));
    format!("  {}", parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(json: &str) -> Post {
        serde_json::from_str(json).unwrap()
    }

    fn simple(id: i64, author: &str, message: &str, created: &str) -> Post {
        post(&format!(
            r#"{{"post_id":{id},"channel_id":"c","message":"{message}",
                 "created_at":"{created}","poster_display_name":"{author}"}}"#
        ))
    }

    #[test]
    fn renders_author_message_and_id() {
        let posts = vec![simple(
            1042,
            "alice",
            "deploy is green",
            "2026-08-14 09:12:33",
        )];
        let out = render(&posts, None, &Style::plain());
        assert!(out.contains("alice"));
        assert!(out.contains("deploy is green"));
        assert!(
            out.contains("[1042]"),
            "post id must always be shown:\n{out}"
        );
    }

    #[test]
    fn emits_a_date_separator_only_when_the_day_changes() {
        let posts = vec![
            simple(1, "alice", "one", "2026-08-14 09:00:00"),
            simple(2, "alice", "two", "2026-08-14 10:00:00"),
            simple(3, "alice", "three", "2026-08-16 10:00:00"),
        ];
        let out = render(&posts, None, &Style::plain());
        let headers = out
            .lines()
            .filter(|l| {
                l.starts_with("Fri")
                    || l.starts_with("Sat")
                    || l.starts_with("Sun")
                    || l.starts_with("Mon")
                    || l.starts_with("Tue")
                    || l.starts_with("Wed")
                    || l.starts_with("Thu")
            })
            .count();
        assert_eq!(headers, 2, "expected one header per distinct day:\n{out}");
    }

    #[test]
    fn empty_channel_says_so() {
        let out = render(&[], None, &Style::plain());
        assert!(out.contains("(no messages)"));
    }

    #[test]
    fn a_reply_shows_the_quoted_parent() {
        let p = post(
            r#"{"post_id":2,"channel_id":"c","message":"confirmed","created_at":"2026-08-14 09:14:00",
                "poster_display_name":"bot","parent_post_id":1,
                "parent_preview":{"post_id":1,"poster_display_name":"alice","message_excerpt":"deploy is green"}}"#,
        );
        let out = render(&[p], None, &Style::plain());
        assert!(out.contains("alice"), "{out}");
        assert!(out.contains("deploy is green"), "{out}");
        assert!(out.contains("confirmed"), "{out}");
        assert!(
            out.contains("> alice:"),
            "ascii fallback arrow expected:\n{out}"
        );
    }

    #[test]
    fn edited_pinned_and_non_published_are_marked() {
        let p = post(
            r#"{"post_id":9,"channel_id":"c","message":"m","created_at":"2026-08-14 09:00:00",
                "edited_at":"2026-08-14 09:05:00","pinned_at":"2026-08-14 09:06:00","status":"streaming"}"#,
        );
        let out = render(&[p], None, &Style::plain());
        assert!(out.contains("(edited)"), "{out}");
        assert!(out.contains("[pinned]"), "{out}");
        assert!(out.contains("[streaming]"), "{out}");
    }

    #[test]
    fn a_published_post_gets_no_status_tag() {
        let out = render(
            &[simple(1, "a", "hi", "2026-08-14 09:00:00")],
            None,
            &Style::plain(),
        );
        assert!(!out.contains("[published]"), "{out}");
    }

    #[test]
    fn multiline_messages_indent_their_continuations() {
        let p = post(
            r#"{"post_id":1,"channel_id":"c","message":"line one\nline two","created_at":"2026-08-14 09:00:00","poster_display_name":"alice"}"#,
        );
        let out = render(&[p], None, &Style::plain());
        let two = out.lines().find(|l| l.contains("line two")).unwrap();
        assert!(
            two.starts_with("    "),
            "continuation must be indented: {two:?}"
        );
        assert!(!two.contains("alice"));
    }

    #[test]
    fn attachments_and_reactions_render_under_the_message() {
        let p = post(
            r#"{"post_id":1,"channel_id":"c","message":"look","created_at":"2026-08-14 09:00:00",
                "files":[{"filename":"canary.png","size_bytes":1258291}],
                "reactions":[{"emoji":"X","count":2}]}"#,
        );
        let out = render(&[p], None, &Style::plain());
        assert!(out.contains("[file] canary.png (1.2 MB)"), "{out}");
        assert!(out.contains("X 2"), "{out}");
    }

    #[test]
    fn attachment_only_post_does_not_render_a_blank_row() {
        let p = post(
            r#"{"post_id":1,"channel_id":"c","message":"","created_at":"2026-08-14 09:00:00",
                "files":[{"filename":"a.png","size_bytes":10}]}"#,
        );
        let out = render(&[p], None, &Style::plain());
        assert!(out.contains("(no text)"), "{out}");
        assert!(out.contains("[file] a.png"), "{out}");
    }

    #[test]
    fn plain_style_output_carries_no_escape_sequences() {
        let p = post(
            r#"{"post_id":1,"channel_id":"c","message":"m","created_at":"2026-08-14 09:00:00",
                "pinned_at":"2026-08-14 09:00:00","reactions":[{"emoji":"x","count":1}]}"#,
        );
        let out = render(&[p], Some("#general"), &Style::plain());
        assert!(!out.contains('\x1b'), "piped output must be plain:\n{out}");
    }

    #[test]
    fn long_author_names_are_truncated_to_keep_the_column_stable() {
        let posts = vec![
            simple(
                1,
                "a-very-long-display-name-indeed",
                "x",
                "2026-08-14 09:00:00",
            ),
            simple(2, "bo", "y", "2026-08-14 09:01:00"),
        ];
        let out = render(&posts, None, &Style::plain());
        for line in out.lines().filter(|l| l.contains(" x") || l.contains(" y")) {
            assert!(
                line.find(['x', 'y']).unwrap() < 40,
                "message column drifted: {line:?}"
            );
        }
    }
}
