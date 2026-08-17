//! `channels`, `members`.

use anyhow::Result;
use chrono::Utc;

use super::{typed, Ctx};
use crate::api::mm;
use crate::cli::{ChannelsArgs, MembersArgs};
use crate::models::{ChannelList, ChannelMemberList};
use crate::render::list::{table, truncate};
use crate::render::time;
use crate::resolve;

pub fn list(ctx: &Ctx, args: &ChannelsArgs) -> Result<()> {
    let org = if args.all_orgs {
        None
    } else {
        ctx.settings.org.as_deref()
    };
    let value = mm::channels_raw(&ctx.client, org)?;
    let Some(listing) = typed::<ChannelList>(ctx, "/api/human/mm/channels", value)? else {
        return Ok(());
    };

    let mut channels: Vec<_> = listing
        .channels
        .into_iter()
        .filter(|c| !args.unread || c.unread_count > 0)
        .filter(|c| !args.dms || c.is_dm())
        .collect();

    // Pinned first, then most recently active — the sidebar's order.
    channels.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.last_message_at.cmp(&a.last_message_at))
    });
    if let Some(limit) = args.limit {
        channels.truncate(limit);
    }

    if channels.is_empty() {
        println!("{}", ctx.style.dim("(no channels)"));
        return Ok(());
    }

    let now = Utc::now();
    let rows: Vec<Vec<String>> = channels
        .iter()
        .map(|c| {
            let mut name = c.label();
            if c.pinned {
                name = format!("{} {name}", ctx.style.glyph("📌", "*"));
            }
            let unread = if c.unread_mention_count > 0 {
                // Mentions pierce mute, so they get the accent even when muted.
                ctx.style
                    .accent(&format!("{}@", c.unread_count.max(c.unread_mention_count)))
            } else if c.unread_count > 0 && c.muted {
                ctx.style.dim(&c.unread_count.to_string())
            } else if c.unread_count > 0 {
                ctx.style.accent(&c.unread_count.to_string())
            } else {
                ctx.style.dim("-")
            };
            let last = c
                .last_message_at
                .as_deref()
                .map(|ts| time::relative(ts, now))
                .unwrap_or_else(|| "-".into());
            let mut preview = c
                .last_message_text
                .as_deref()
                .map(|t| truncate(t, 48))
                .unwrap_or_default();
            if c.last_message_attachment_count > 0 {
                preview = format!("{} {preview}", ctx.style.glyph("📎", "[file]"));
            }
            if let Some(author) = &c.last_message_author_display_name {
                if !preview.is_empty() {
                    preview = format!("{}: {preview}", ctx.style.dim(author));
                }
            }
            vec![name, unread, ctx.style.dim(&last), preview]
        })
        .collect();

    print!(
        "{}",
        table(&["NAME", "UNREAD", "LAST", "PREVIEW"], &rows, &ctx.style)
    );
    Ok(())
}

pub fn members(ctx: &Ctx, args: &MembersArgs) -> Result<()> {
    let channel = resolve::channel(&ctx.client, &ctx.settings, &args.channel)?;
    let path = mm::channel_path(&channel.channel_id, "/members");
    let value = ctx.client.get(&path, &[])?;
    let Some(listing) = typed::<ChannelMemberList>(ctx, &path, value)? else {
        return Ok(());
    };

    if listing.members.is_empty() {
        println!("{}", ctx.style.dim("(no members)"));
        return Ok(());
    }

    let rows: Vec<Vec<String>> = listing
        .members
        .iter()
        .map(|m| {
            let kind = if m.agent_id.is_some() {
                "agent"
            } else {
                "human"
            };
            let id = m
                .agent_id
                .clone()
                .or_else(|| m.human_id.map(|i| i.to_string()))
                .unwrap_or_default();
            vec![
                m.display_name.clone().unwrap_or_else(|| id.clone()),
                kind.to_string(),
                id,
                ctx.style.dim(m.status.as_deref().unwrap_or("")),
            ]
        })
        .collect();

    print!(
        "{}",
        table(&["NAME", "KIND", "ID", "STATUS"], &rows, &ctx.style)
    );
    Ok(())
}
