//! Collapsing flags, environment and config into one resolved view.
//!
//! [`resolve`] is a pure function of its inputs so the whole precedence matrix
//! is testable without touching the filesystem or the environment.
//!
//! Precedence is **flag > environment > config file > built-in default**. The
//! flag-over-environment half is clap's doing (`#[arg(env = ...)]` folds the
//! variable into the flag's value); this module handles the rest.
//!
//! The token does *not* participate. It has its own chain — `$CLAWBITS_TOKEN`
//! then the session file — and no flag, because argv is world-readable.

use std::time::Duration;

use crate::cli::{Cli, ColorMode};
use crate::config::{Config, DEFAULT_BASE_URL, DEFAULT_PROFILE};

#[derive(Debug, Clone)]
pub struct Settings {
    pub base_url: String,
    pub profile: String,
    pub org: Option<String>,
    pub json: bool,
    pub color: ColorMode,
    pub timeout: Duration,
    pub verbose: bool,
}

pub fn resolve(cli: &Cli, config: &Config) -> Settings {
    // The profile has to be settled first: it selects the config section that
    // supplies the other two defaults.
    let profile = cli
        .profile
        .clone()
        .or_else(|| config.default_profile.clone())
        .unwrap_or_else(|| DEFAULT_PROFILE.to_string());

    let section = config.profile(&profile);

    let base_url = cli
        .base_url
        .clone()
        .or_else(|| section.and_then(|p| p.base_url.clone()))
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());

    let org = cli
        .org
        .clone()
        .or_else(|| section.and_then(|p| p.org.clone()));

    Settings {
        base_url: base_url.trim_end_matches('/').to_string(),
        profile,
        org,
        json: cli.json,
        color: cli.color,
        timeout: Duration::from_secs(cli.timeout),
        verbose: cli.verbose,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Command;
    use clap::Parser;

    fn cli(args: &[&str]) -> Cli {
        let mut full = vec!["clawbits"];
        full.extend_from_slice(args);
        full.push("whoami");
        Cli::try_parse_from(full).unwrap()
    }

    fn config_with(profile: &str, base: Option<&str>, org: Option<&str>) -> Config {
        let mut c = Config::default();
        let p = c.profile_mut(profile);
        p.base_url = base.map(str::to_string);
        p.org = org.map(str::to_string);
        c
    }

    #[test]
    fn built_in_defaults_when_nothing_is_set() {
        let s = resolve(&cli(&[]), &Config::default());
        assert_eq!(s.base_url, DEFAULT_BASE_URL);
        assert_eq!(s.profile, DEFAULT_PROFILE);
        assert_eq!(s.org, None);
    }

    #[test]
    fn config_beats_the_default() {
        let cfg = config_with("default", Some("https://app.clawbits.ai"), Some("org_1"));
        let s = resolve(&cli(&[]), &cfg);
        assert_eq!(s.base_url, "https://app.clawbits.ai");
        assert_eq!(s.org.as_deref(), Some("org_1"));
    }

    #[test]
    fn flag_beats_the_config() {
        let cfg = config_with("default", Some("https://app.clawbits.ai"), Some("org_1"));
        let s = resolve(
            &cli(&["--base-url", "http://localhost:8000", "--org", "org_2"]),
            &cfg,
        );
        assert_eq!(s.base_url, "http://localhost:8000");
        assert_eq!(s.org.as_deref(), Some("org_2"));
    }

    #[test]
    fn profile_selects_which_config_section_applies() {
        let mut cfg = config_with("default", Some("http://localhost:8000"), None);
        cfg.profile_mut("prod").base_url = Some("https://app.clawbits.ai".into());
        cfg.profile_mut("prod").org = Some("org_prod".into());

        let s = resolve(&cli(&["--profile", "prod"]), &cfg);
        assert_eq!(s.profile, "prod");
        assert_eq!(s.base_url, "https://app.clawbits.ai");
        assert_eq!(s.org.as_deref(), Some("org_prod"));
    }

    #[test]
    fn default_profile_from_config_is_honoured() {
        let mut cfg = config_with("work", Some("https://work.example"), None);
        cfg.default_profile = Some("work".into());
        let s = resolve(&cli(&[]), &cfg);
        assert_eq!(s.profile, "work");
        assert_eq!(s.base_url, "https://work.example");
    }

    #[test]
    fn profile_flag_beats_config_default_profile() {
        let mut cfg = config_with("work", Some("https://work.example"), None);
        cfg.default_profile = Some("work".into());
        cfg.profile_mut("play").base_url = Some("https://play.example".into());
        let s = resolve(&cli(&["--profile", "play"]), &cfg);
        assert_eq!(s.base_url, "https://play.example");
    }

    #[test]
    fn unknown_profile_falls_back_to_built_in_defaults() {
        let cfg = config_with("default", Some("https://app.clawbits.ai"), Some("org_1"));
        let s = resolve(&cli(&["--profile", "ghost"]), &cfg);
        assert_eq!(s.base_url, DEFAULT_BASE_URL);
        assert_eq!(s.org, None);
    }

    #[test]
    fn trailing_slash_is_stripped_once_here_so_no_url_join_has_to_care() {
        let s = resolve(
            &cli(&["--base-url", "https://app.clawbits.ai/"]),
            &Config::default(),
        );
        assert_eq!(s.base_url, "https://app.clawbits.ai");
    }

    #[test]
    fn passthrough_flags_survive() {
        let c = cli(&["--json", "--verbose", "--timeout", "5", "--color", "never"]);
        let s = resolve(&c, &Config::default());
        assert!(s.json);
        assert!(s.verbose);
        assert_eq!(s.timeout, Duration::from_secs(5));
        assert_eq!(s.color, ColorMode::Never);
        assert!(matches!(c.command, Command::Whoami));
    }
}
