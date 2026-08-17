//! `login`, `logout`, `whoami`.

use anyhow::{bail, Result};

use super::{prompt, Ctx};
use crate::api::auth;
use crate::cli::{LoginArgs, LogoutArgs};
use crate::render::print_json;
use crate::session::{SessionRecord, SessionStore};

pub fn login(ctx: &mut Ctx, args: &LoginArgs) -> Result<()> {
    let (me, token, kind) = if args.pat {
        let (me, token) = pat_login(ctx)?;
        (me, token, "pat")
    } else if args.dev {
        let me = dev_login(ctx, args)?;
        let Some(token) = me.token.clone() else {
            bail!("the server did not return a session token; cannot stay signed in");
        };
        (me, token, "dev")
    } else {
        let me = magic_login(ctx, args)?;
        let Some(token) = me.token.clone() else {
            bail!("the server did not return a session token; cannot stay signed in");
        };
        (me, token, "workos")
    };

    let mut store = SessionStore::load(&ctx.paths.sessions)?;
    store.set(
        &ctx.settings.profile,
        SessionRecord {
            token,
            kind: kind.into(),
            email: Some(me.email.clone()),
            human_id: Some(me.id),
            base_url: ctx.settings.base_url.clone(),
            created_at: Some(chrono::Utc::now().to_rfc3339()),
        },
    );
    store.save(&ctx.paths.sessions)?;

    if args.save_base_url {
        ctx.config.profile_mut(&ctx.settings.profile).base_url =
            Some(ctx.settings.base_url.clone());
        ctx.config.save(&ctx.paths.config)?;
    }

    if ctx.settings.json {
        print_json(&serde_json::json!({
            "id": me.id,
            "email": me.email,
            "display_name": me.display_name,
            "profile": ctx.settings.profile,
            "base_url": ctx.settings.base_url,
        }));
        return Ok(());
    }

    println!(
        "Signed in as {} at {} (profile {}).",
        ctx.style.bold(me.label()),
        ctx.settings.base_url,
        ctx.settings.profile
    );
    Ok(())
}

/// Sign in with an existing personal access token, read from stdin.
///
/// Stdin-only: a `--token <value>` flag would put the credential on argv,
/// which any local process can read via `ps`. The token is validated with a
/// real request before it is stored, so a typo fails here and not on the
/// next command.
fn pat_login(ctx: &Ctx) -> Result<(crate::models::Me, String)> {
    use std::io::{IsTerminal, Read};

    let mut raw = String::new();
    if std::io::stdin().is_terminal() {
        // Interactive paste. Line-read, echoed — fine for a terminal you're
        // sitting at; scripts should pipe instead.
        raw = prompt("Paste token (input is visible): ")?;
    } else {
        std::io::stdin().read_to_string(&mut raw)?;
    }
    let token = raw.trim().to_string();
    if token.is_empty() {
        bail!(
            "no token on stdin.\n  \
             Mint one with: cbs tokens create --label <name>\n  \
             Then: cbs login --pat < token.txt"
        );
    }
    if !token.starts_with("cbp_") {
        bail!(
            "that doesn't look like a personal access token (they start with cbp_).\n  \
             Agent keys (fc_…) belong to agents and cannot sign in a human."
        );
    }

    // Validate against the server with the token itself.
    let probe = crate::api::Client::new(
        &ctx.settings.base_url,
        Some(token.clone()),
        ctx.settings.timeout,
        ctx.settings.verbose,
    );
    let me: crate::models::Me = probe.get_as("/api/auth/me", &[])?;
    Ok((me, token))
}

fn dev_login(ctx: &Ctx, args: &LoginArgs) -> Result<crate::models::Me> {
    // The endpoint 404s when the bypass is off, which on its own reads like a
    // typo'd URL. Say what the gate actually is.
    if !auth::dev_enabled(&ctx.client)? {
        bail!(
            "dev auth is not enabled on {}.\n  \
             It requires CLAWBITS_DEV_AUTH=1 *and* CLAWBITS_ENV set to one of \
             development, dev, local or test.\n  \
             For a real deployment, sign in with an emailed code: cbs login --email you@example.com",
            ctx.settings.base_url
        );
    }
    let email = match &args.email {
        Some(e) => e.clone(),
        None => prompt("Email: ")?,
    };
    if email.is_empty() {
        bail!("an email is required");
    }
    Ok(auth::dev_login(
        &ctx.client,
        &email,
        args.display_name.as_deref(),
    )?)
}

fn magic_login(ctx: &Ctx, args: &LoginArgs) -> Result<crate::models::Me> {
    let email = match &args.email {
        Some(e) => e.clone(),
        None => prompt("Email: ")?,
    };
    if email.is_empty() {
        bail!("an email is required");
    }

    let code = match &args.code {
        Some(c) => c.clone(),
        None => {
            auth::magic_send(&ctx.client, &email)?;
            super::super::render::hint(&format!("A 6-digit code is on its way to {email}."));
            prompt("Code: ")?
        }
    };

    // Check locally: the server's rejection for a malformed code is a Pydantic
    // pattern error, which is a poor way to learn you pasted the wrong thing.
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        bail!("the code must be exactly 6 digits; got {code:?}");
    }

    Ok(auth::magic_verify(&ctx.client, &email, &code)?)
}

pub fn logout(ctx: &Ctx, args: &LogoutArgs) -> Result<()> {
    // Best effort: it only clears cookies, and we may not even have a session.
    let _ = auth::logout(&ctx.client);

    let mut store = SessionStore::load(&ctx.paths.sessions)?;
    let had = if args.all {
        let any = !store.sessions.is_empty();
        store.clear();
        any
    } else {
        store.remove(&ctx.settings.profile)
    };
    store.save(&ctx.paths.sessions)?;

    if ctx.settings.json {
        print_json(&serde_json::json!({ "removed": had, "all": args.all }));
        return Ok(());
    }

    if !had {
        println!("No stored session to remove.");
        return Ok(());
    }
    if args.all {
        println!("Removed every stored session.");
    } else {
        println!(
            "Removed the stored session for profile {}.",
            ctx.settings.profile
        );
    }
    // Don't imply more than happened: the server-side handler only deletes
    // cookies, so a bearer token keeps working until it expires by itself.
    println!(
        "{}",
        ctx.style
            .dim("Note: this clears the local token only — the server does not revoke it.")
    );
    Ok(())
}

pub fn whoami(ctx: &Ctx) -> Result<()> {
    let value = ctx.client.get("/api/auth/me", &[])?;
    let Some(me) = super::typed::<crate::models::Me>(ctx, "/api/auth/me", value)? else {
        return Ok(());
    };
    println!(
        "{} <{}>  {}",
        ctx.style.bold(me.label()),
        me.email,
        ctx.style.dim(&format!(
            "human_id {} · profile {} · {}",
            me.id, ctx.settings.profile, ctx.settings.base_url
        ))
    );
    Ok(())
}
