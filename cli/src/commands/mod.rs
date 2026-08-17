//! Command implementations.

pub mod auth;
pub mod cfg;
pub mod channels;
pub mod dm;
pub mod orgs;
pub mod post;
pub mod raw;
pub mod read;
pub mod search;
pub mod tokens;

use anyhow::Result;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::api::{ApiError, Client};
use crate::cli::Command;
use crate::config::{Config, Paths};
use crate::render::style::Style;
use crate::settings::Settings;

pub struct Ctx {
    pub client: Client,
    pub settings: Settings,
    pub paths: Paths,
    pub config: Config,
    pub style: Style,
}

/// In `--json` mode print the server's payload verbatim and stop; otherwise
/// hand back the typed value for rendering.
///
/// Going through `Value` rather than deserializing off the wire is what makes
/// `--json` lossless: fields this binary doesn't model yet still reach the
/// caller's `jq`.
pub fn typed<T: DeserializeOwned>(ctx: &Ctx, path: &str, value: Value) -> Result<Option<T>> {
    if ctx.settings.json {
        crate::render::print_json(&value);
        return Ok(None);
    }
    let parsed = serde_json::from_value(value).map_err(|source| ApiError::Decode {
        path: path.to_string(),
        source,
    })?;
    Ok(Some(parsed))
}

pub fn dispatch(ctx: &mut Ctx, command: &Command) -> Result<()> {
    match command {
        Command::Login(args) => auth::login(ctx, args),
        Command::Logout(args) => auth::logout(ctx, args),
        Command::Whoami => auth::whoami(ctx),
        Command::Orgs(args) => orgs::run(ctx, args),
        Command::Channels(args) => channels::list(ctx, args),
        Command::Members(args) => channels::members(ctx, args),
        Command::Read(args) => read::run(ctx, args),
        Command::Post(args) => post::run(ctx, args),
        Command::Dm(args) => dm::run(ctx, args),
        Command::Search(args) => search::run(ctx, args),
        Command::Tokens(args) => tokens::run(ctx, args),
        Command::Raw(args) => raw::run(ctx, args),
        Command::Config(args) => cfg::run(ctx, args),
        Command::Completions { shell } => cfg::completions(*shell),
    }
}

/// Read a line from stdin, after writing `label` to stderr.
///
/// The prompt goes to stderr so `cbs login < answers.txt > out` keeps
/// stdout clean.
pub fn prompt(label: &str) -> Result<String> {
    use std::io::{BufRead, Write};
    eprint!("{label}");
    std::io::stderr().flush()?;
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    Ok(line.trim().to_string())
}

/// Shared by `post` and `dm send`: where the message text comes from.
pub fn message_text(input: &crate::cli::MessageInput) -> Result<String> {
    use std::io::{IsTerminal, Read};

    if let Some(m) = &input.message {
        return Ok(m.clone());
    }
    if input.stdin || !std::io::stdin().is_terminal() {
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf)?;
        return Ok(buf.trim_end_matches('\n').to_string());
    }
    editor_text()
}

/// Compose in `$EDITOR`. An empty buffer means "cancel", the same convention
/// git uses for a commit message.
fn editor_text() -> Result<String> {
    use std::io::Write;

    let editor = std::env::var("EDITOR")
        .or_else(|_| std::env::var("VISUAL"))
        .unwrap_or_else(|_| "vi".to_string());

    let path = std::env::temp_dir().join(format!("clawbits-msg-{}.md", std::process::id()));
    {
        let mut f = create_private(&path)?;
        writeln!(f)?;
    }

    let status = std::process::Command::new(&editor).arg(&path).status();
    let body = std::fs::read_to_string(&path).unwrap_or_default();
    let _ = std::fs::remove_file(&path);

    match status {
        Ok(s) if s.success() => {}
        Ok(s) => anyhow::bail!("{editor} exited with {s}; message not sent"),
        Err(e) => anyhow::bail!(
            "could not launch {editor}: {e}\n  \
             Pass the message with -m instead, or pipe it in with --stdin."
        ),
    }

    let text = body.trim().to_string();
    if text.is_empty() {
        anyhow::bail!("empty message; nothing sent");
    }
    Ok(text)
}

/// A draft can contain anything the user is about to say. Create it 0600 rather
/// than inheriting a permissive umask in a shared /tmp.
#[cfg(unix)]
fn create_private(path: &std::path::Path) -> Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    let _ = std::fs::remove_file(path);
    Ok(std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?)
}

#[cfg(not(unix))]
fn create_private(path: &std::path::Path) -> Result<std::fs::File> {
    let _ = std::fs::remove_file(path);
    Ok(std::fs::File::create(path)?)
}

/// Only `Client` knows the token; only this knows where it lives.
pub fn persist_rotated_token(ctx: &Ctx) {
    let Some(token) = ctx.client.take_rotated_token() else {
        return;
    };
    let mut store = match crate::session::SessionStore::load(&ctx.paths.sessions) {
        Ok(s) => s,
        Err(_) => return,
    };
    let Some(existing) = store.get(&ctx.settings.profile).cloned() else {
        return;
    };
    if existing.token == token {
        return;
    }
    let updated = crate::session::SessionRecord { token, ..existing };
    store.set(&ctx.settings.profile, updated);
    let _ = store.save(&ctx.paths.sessions);
}
