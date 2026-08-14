//! `clawbits` — a terminal client for the Clawbits human messaging API.
//!
//! Wiring only: parse, resolve settings, load the session, dispatch, and turn
//! whatever comes back into an exit code. The interesting parts live in
//! [`api`], [`commands`] and [`render`].

mod api;
mod cli;
mod commands;
mod config;
mod models;
mod render;
mod resolve;
mod session;
mod settings;

use anyhow::Result;
use clap::Parser;

use api::{ApiError, Client};
use cli::{Cli, Command};
use commands::Ctx;
use config::{Config, Paths};
use render::style::Style;
use session::SessionStore;

fn main() {
    let cli = Cli::parse();
    match run(&cli) {
        Ok(()) => {}
        Err(err) => {
            report(&cli, &err);
            std::process::exit(exit_code(&err));
        }
    }
}

fn run(cli: &Cli) -> Result<()> {
    let paths = Paths::from_env()?;
    let config = Config::load(&paths.config)?;
    let settings = settings::resolve(cli, &config);

    let token = load_token(&paths, &settings)?;

    let mut ctx = Ctx {
        client: Client::new(
            &settings.base_url,
            token,
            settings.timeout,
            settings.verbose,
        ),
        style: if settings.json {
            Style::plain()
        } else {
            Style::decide(settings.color)
        },
        settings,
        paths,
        config,
    };

    let result = commands::dispatch(&mut ctx, &cli.command);

    // Even on failure: the rotation may well have arrived on the response that
    // then turned out to be a 4xx for some unrelated reason.
    commands::persist_rotated_token(&ctx);
    result
}

/// The token chain: `$CLAWBITS_TOKEN` first, then the session file. No flag
/// participates — argv is world-readable.
fn load_token(paths: &Paths, settings: &settings::Settings) -> Result<Option<String>> {
    if let Ok(token) = std::env::var("CLAWBITS_TOKEN") {
        if !token.trim().is_empty() {
            return Ok(Some(token));
        }
    }

    let store = SessionStore::load(&paths.sessions)?;
    let Some(record) = store.get(&settings.profile) else {
        return Ok(None);
    };

    // A session minted against one deployment must not be sent to another —
    // otherwise a stray --base-url hands a production token to whoever is
    // listening on the other end.
    if !record.matches_base_url(&settings.base_url) {
        render::hint(&format!(
            "warning: the stored session for profile {} was issued by {}, not {} — \
             not sending it.\n  Sign in again with: clawbits --base-url {} login",
            settings.profile, record.base_url, settings.base_url, settings.base_url
        ));
        return Ok(None);
    }

    Ok(Some(record.token.clone()))
}

fn report(cli: &Cli, err: &anyhow::Error) {
    eprintln!("error: {err}");
    for cause in err.chain().skip(1) {
        eprintln!("  caused by: {cause}");
    }

    // One place handles 401, so no command has to remember to.
    if let Some(ApiError::Unauthorized(_)) = err.downcast_ref::<ApiError>() {
        let profile = cli.profile.as_deref().unwrap_or("default");
        let suffix = if profile == "default" {
            String::new()
        } else {
            format!(" --profile {profile}")
        };
        eprintln!("  run: clawbits{suffix} login");
    }
}

fn exit_code(err: &anyhow::Error) -> i32 {
    match err.downcast_ref::<ApiError>() {
        Some(api) => api.exit_code(),
        None => 1,
    }
}

/// Compile-time reminder that every command is reachable from `dispatch`.
/// A new variant that nobody wired up fails here rather than at runtime.
#[allow(dead_code)]
fn exhaustive(command: &Command) -> &'static str {
    match command {
        Command::Login(_) => "login",
        Command::Logout(_) => "logout",
        Command::Whoami => "whoami",
        Command::Orgs(_) => "orgs",
        Command::Channels(_) => "channels",
        Command::Read(_) => "read",
        Command::Post(_) => "post",
        Command::Dm(_) => "dm",
        Command::Members(_) => "members",
        Command::Search(_) => "search",
        Command::Tokens(_) => "tokens",
        Command::Raw(_) => "raw",
        Command::Config(_) => "config",
        Command::Completions { .. } => "completions",
    }
}
