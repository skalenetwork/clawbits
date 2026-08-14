//! `read` — a channel as a transcript.

use anyhow::Result;

use super::{typed, Ctx};
use crate::api::mm;
use crate::cli::ReadArgs;
use crate::models::{Post, PostList};
use crate::render::{hint, transcript};
use crate::resolve;

pub fn run(ctx: &Ctx, args: &ReadArgs) -> Result<()> {
    let channel = resolve::channel(&ctx.client, &ctx.settings, &args.channel)?;
    let path = mm::channel_path(&channel.channel_id, "/posts");

    // A thread filter is applied client-side (there is no thread endpoint), so
    // widen the window or a reply chain that has scrolled up gets missed.
    let limit = match args.thread {
        Some(_) => args.limit.max(200),
        None => args.limit,
    };
    let query = mm::posts_query(limit, args.before, args.after);

    let value = ctx.client.get(&path, &query)?;
    let Some(listing) = typed::<PostList>(ctx, &path, value)? else {
        return Ok(());
    };
    let mut posts = listing.posts;
    let fetched = posts.len();

    if let Some(root) = args.thread {
        let reached = posts.iter().any(|p| p.post_id == root);
        posts.retain(|p| p.post_id == root || p.parent_post_id == Some(root));
        if !reached {
            hint(&format!(
                "note: post {root} is older than the {fetched} messages fetched; \
                 re-run with -n <larger> or --before to reach it."
            ));
        }
    }

    // The API returns newest-first. A transcript reads the other way.
    posts.reverse();

    let header = build_header(ctx, &channel);
    print!("{}", transcript::render(&posts, Some(&header), &ctx.style));

    if fetched as u32 == limit {
        if let Some(oldest) = posts.first() {
            hint(&format!(
                "more above — continue with: cbs read {} --before {}",
                args.channel, oldest.post_id
            ));
        }
    }

    if args.mark_read {
        mark_read(ctx, &channel.channel_id, &posts)?;
    }
    Ok(())
}

fn build_header(ctx: &Ctx, channel: &crate::models::Channel) -> String {
    let mut header = channel.label();
    if channel.unread_count > 0 {
        header.push_str(&format!(" · {} unread", channel.unread_count));
    }
    if channel.muted {
        header.push_str(&format!(" · {}", ctx.style.dim("muted")));
    }
    header
}

/// Mark up to the newest post actually shown, not the newest that exists — the
/// user has only seen what was printed.
fn mark_read(ctx: &Ctx, channel_id: &str, posts: &[Post]) -> Result<()> {
    let Some(newest) = posts.iter().map(|p| p.post_id).max() else {
        return Ok(());
    };
    mm::mark_read(&ctx.client, channel_id, newest)?;
    hint(&format!("marked read up to post {newest}"));
    Ok(())
}
