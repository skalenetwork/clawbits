//! `tokens create|list|revoke` — personal access tokens.
//!
//! The server rule worth knowing here: minting requires an *interactive*
//! session (magic-code or dev login). A PAT can list and revoke, but can't
//! mint further PATs — so if `tokens create` returns 403 while you're signed
//! in with one, that's the server working as intended, not a bug.

use anyhow::Result;
use serde::Deserialize;
use serde_json::json;

use super::{typed, Ctx};
use crate::cli::{TokensArgs, TokensCommand};
use crate::render::hint;
use crate::render::list::table;
use crate::render::time;

pub fn run(ctx: &Ctx, args: &TokensArgs) -> Result<()> {
    match &args.cmd {
        TokensCommand::Create {
            label,
            expires_days,
        } => create(ctx, label, *expires_days),
        TokensCommand::List => list(ctx),
        TokensCommand::Revoke { token_id } => revoke(ctx, *token_id),
    }
}

#[derive(Debug, Deserialize)]
struct Created {
    token_id: i64,
    token: String,
    #[serde(default)]
    expires_at: Option<String>,
}

fn create(ctx: &Ctx, label: &str, expires_days: Option<u32>) -> Result<()> {
    let mut body = json!({ "label": label });
    if let Some(days) = expires_days {
        body["expires_in_days"] = json!(days);
    }
    let value = ctx.client.post("/api/human/tokens", &body)?;
    let Some(created) = typed::<Created>(ctx, "/api/human/tokens", value)? else {
        return Ok(());
    };

    // Plaintext alone on stdout so `cbs tokens create --label ci` can be
    // captured or piped; everything human goes to stderr.
    hint(&format!(
        "Token {} ({label}) created{}. This is the only time it is shown — store it now.",
        created.token_id,
        match &created.expires_at {
            Some(ts) => format!(", expires {}", time::clock_and_date(ts)),
            None => ", no expiry".to_string(),
        }
    ));
    hint("Use it with: export CLAWBITS_TOKEN=<token>   or: cbs login --pat");
    println!("{}", created.token);
    Ok(())
}

fn list(ctx: &Ctx) -> Result<()> {
    #[derive(Debug, Deserialize)]
    struct Entry {
        token_id: i64,
        label: String,
        token_hint: String,
        #[serde(default)]
        created_at: Option<String>,
        #[serde(default)]
        expires_at: Option<String>,
        #[serde(default)]
        last_used_at: Option<String>,
    }
    #[derive(Debug, Deserialize)]
    struct Listing {
        #[serde(default)]
        tokens: Vec<Entry>,
    }

    let value = ctx.client.get("/api/human/tokens", &[])?;
    let Some(listing) = typed::<Listing>(ctx, "/api/human/tokens", value)? else {
        return Ok(());
    };

    if listing.tokens.is_empty() {
        println!("{}", ctx.style.dim("(no tokens)"));
        return Ok(());
    }

    let fmt = |ts: &Option<String>| match ts {
        Some(t) => time::clock_and_date(t),
        None => "-".to_string(),
    };
    let rows: Vec<Vec<String>> = listing
        .tokens
        .iter()
        .map(|t| {
            vec![
                t.token_id.to_string(),
                t.label.clone(),
                ctx.style.dim(&format!("{}…", t.token_hint)),
                ctx.style.dim(&fmt(&t.created_at)),
                fmt(&t.expires_at),
                ctx.style.dim(&fmt(&t.last_used_at)),
            ]
        })
        .collect();
    print!(
        "{}",
        table(
            &["ID", "LABEL", "TOKEN", "CREATED", "EXPIRES", "LAST USED"],
            &rows,
            &ctx.style
        )
    );
    Ok(())
}

fn revoke(ctx: &Ctx, token_id: i64) -> Result<()> {
    ctx.client.request(
        crate::api::Method::Delete,
        &format!("/api/human/tokens/{token_id}"),
        &[],
        None,
    )?;
    if ctx.settings.json {
        crate::render::print_json(&json!({ "revoked": token_id }));
        return Ok(());
    }
    println!("Token {token_id} revoked. Anything still using it gets a 401 from now on.");
    Ok(())
}
