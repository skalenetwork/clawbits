//! `config path`, `completions`.

use anyhow::Result;
use clap::CommandFactory;

use super::Ctx;
use crate::cli::{Cli, ConfigArgs, ConfigCommand};

pub fn run(ctx: &Ctx, args: &ConfigArgs) -> Result<()> {
    match args.cmd {
        ConfigCommand::Path => path(ctx),
    }
}

fn path(ctx: &Ctx) -> Result<()> {
    if ctx.settings.json {
        crate::render::print_json(&serde_json::json!({
            "config": ctx.paths.config,
            "sessions": ctx.paths.sessions,
            "profile": ctx.settings.profile,
            "base_url": ctx.settings.base_url,
            "org": ctx.settings.org,
        }));
        return Ok(());
    }
    println!("config    {}", ctx.paths.config.display());
    println!("sessions  {}", ctx.paths.sessions.display());
    println!("profile   {}", ctx.settings.profile);
    println!("base_url  {}", ctx.settings.base_url);
    println!(
        "org       {}",
        ctx.settings.org.as_deref().unwrap_or("(none)")
    );
    Ok(())
}

pub fn completions(shell: clap_complete::Shell) -> Result<()> {
    let mut cmd = Cli::command();
    let name = cmd.get_name().to_string();
    clap_complete::generate(shell, &mut cmd, name, &mut std::io::stdout());
    Ok(())
}
