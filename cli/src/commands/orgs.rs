//! `orgs`, `orgs use`.

use anyhow::Result;

use super::{typed, Ctx};
use crate::cli::{OrgsArgs, OrgsCommand};
use crate::models::OrgList;
use crate::render::list::table;
use crate::resolve;

pub fn run(ctx: &mut Ctx, args: &OrgsArgs) -> Result<()> {
    match &args.cmd {
        Some(OrgsCommand::Use { org }) => use_org(ctx, org),
        None => list(ctx),
    }
}

fn list(ctx: &Ctx) -> Result<()> {
    let value = ctx.client.get("/api/human/orgs", &[])?;
    let Some(orgs) = typed::<OrgList>(ctx, "/api/human/orgs", value)? else {
        return Ok(());
    };

    if orgs.organizations.is_empty() {
        println!("{}", ctx.style.dim("(no organizations)"));
        return Ok(());
    }

    let current = ctx.settings.org.as_deref();
    let rows: Vec<Vec<String>> = orgs
        .organizations
        .iter()
        .map(|o| {
            let marker = if current == Some(o.org_id.as_str()) {
                ctx.style.bold("*")
            } else {
                " ".to_string()
            };
            vec![
                marker,
                o.org_id.clone(),
                o.label().to_string(),
                o.my_role.clone().unwrap_or_default(),
                unread(ctx, o.unread_count),
                if o.is_personal {
                    "personal".into()
                } else {
                    String::new()
                },
            ]
        })
        .collect();

    print!(
        "{}",
        table(
            &[" ", "ORG_ID", "NAME", "ROLE", "UNREAD", ""],
            &rows,
            &ctx.style
        )
    );
    Ok(())
}

fn use_org(ctx: &mut Ctx, needle: &str) -> Result<()> {
    let org = resolve::org(&ctx.client, needle)?;
    ctx.config.profile_mut(&ctx.settings.profile).org = Some(org.org_id.clone());
    ctx.config.save(&ctx.paths.config)?;

    if ctx.settings.json {
        crate::render::print_json(&serde_json::json!({
            "org_id": org.org_id,
            "name": org.name,
            "profile": ctx.settings.profile,
        }));
        return Ok(());
    }
    println!(
        "Default organization for profile {} is now {} ({}).",
        ctx.settings.profile,
        ctx.style.bold(org.label()),
        org.org_id
    );
    Ok(())
}

fn unread(ctx: &Ctx, count: i64) -> String {
    if count > 0 {
        ctx.style.accent(&count.to_string())
    } else {
        ctx.style.dim("0")
    }
}
