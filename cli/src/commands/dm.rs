//! `dm list`, `dm open`, `dm send`.

use anyhow::{bail, Result};
use serde_json::json;

use super::{message_text, Ctx};
use crate::cli::{ChannelsArgs, DmArgs, DmCommand, DmSendArgs, DmTarget};
use crate::models::Channel;
use crate::resolve;

pub fn run(ctx: &Ctx, args: &DmArgs) -> Result<()> {
    match &args.cmd {
        DmCommand::List => list(ctx),
        DmCommand::Open(target) => open_and_report(ctx, target),
        DmCommand::Send(args) => send(ctx, args),
    }
}

fn list(ctx: &Ctx) -> Result<()> {
    // Same view as `channels --dms`; keeping one implementation means the two
    // can't drift.
    super::channels::list(
        ctx,
        &ChannelsArgs {
            all_orgs: false,
            unread: false,
            dms: true,
            limit: None,
        },
    )
}

/// Open (or find) the DM channel. Idempotent server-side.
fn open(ctx: &Ctx, target: &DmTarget) -> Result<Channel> {
    let org = resolve::require_org(&ctx.settings)?;

    let (target_id, target_type) = match (&target.user, &target.agent) {
        (Some(user), None) => {
            let id = resolve::human_id(&ctx.client, &org, user)?;
            (id.to_string(), "human")
        }
        (None, Some(agent)) => {
            // Checks `can_dm` first so a closed contact permission is explained
            // rather than surfacing as a bare 403 from the post that follows.
            let found = resolve::agent_for_dm(&ctx.client, &org, agent)?;
            (found.agent_id, "agent")
        }
        _ => bail!("specify exactly one of --user or --agent"),
    };

    let value = ctx.client.post(
        "/api/human/mm/direct",
        &json!({ "org_id": org, "target_id": target_id, "target_type": target_type }),
    )?;
    Ok(serde_json::from_value(value)?)
}

fn open_and_report(ctx: &Ctx, target: &DmTarget) -> Result<()> {
    let channel = open(ctx, target)?;

    if ctx.settings.json {
        crate::render::print_json(&json!({
            "channel_id": channel.channel_id,
            "display_name": channel.display_name,
            "channel_type": channel.channel_type,
        }));
        return Ok(());
    }
    println!(
        "{}  {}",
        ctx.style.bold(&channel.label()),
        ctx.style.dim(&channel.channel_id)
    );
    println!(
        "{}",
        ctx.style
            .dim(&format!("Read it with: cbs read {}", channel.channel_id))
    );
    Ok(())
}

fn send(ctx: &Ctx, args: &DmSendArgs) -> Result<()> {
    // Compose before opening the channel: if the editor is abandoned or the
    // message is too long, nothing has happened yet.
    let body = message_text(&args.message)?;
    super::post::validate(&body)?;

    let channel = open(ctx, &args.target)?;
    let value = super::post::create(ctx, &channel.channel_id, &body, args.reply_to)?;
    super::post::report(ctx, &channel.label(), value)
}
