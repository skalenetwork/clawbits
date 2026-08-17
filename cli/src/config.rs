//! On-disk configuration: `config.toml`.
//!
//! Deliberately separate from `sessions.toml` (see [`crate::session`]). This
//! file holds nothing secret — server URL and default org — so it can live in
//! a dotfiles repo. The token file cannot, and keeping them apart means you
//! don't have to think about it.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Where the CLI keeps its two files.
///
/// Constructed from the environment in normal use; tests build one rooted at a
/// tempdir instead of mutating process-global `XDG_*` vars, which would race
/// across parallel test threads.
#[derive(Debug, Clone)]
pub struct Paths {
    pub config: PathBuf,
    pub sessions: PathBuf,
}

impl Paths {
    pub fn from_env() -> Result<Self> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .context("HOME is not set; cannot locate the clawbits config directory")?;

        let config_home = xdg_dir("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"));
        // State, not data: a session token is regenerable and should not ride
        // along in the tree users back up and sync.
        let state_home = xdg_dir("XDG_STATE_HOME").unwrap_or_else(|| home.join(".local/state"));

        Ok(Self {
            config: config_home.join("clawbits/config.toml"),
            sessions: state_home.join("clawbits/sessions.toml"),
        })
    }

    /// Both files under one root. Test helper — real runs go through
    /// [`Paths::from_env`], and tests use this instead of mutating the
    /// process-global `XDG_*` vars, which would race across test threads.
    #[cfg(test)]
    pub fn under(root: &Path) -> Self {
        Self {
            config: root.join("config/clawbits/config.toml"),
            sessions: root.join("state/clawbits/sessions.toml"),
        }
    }
}

fn xdg_dir(var: &str) -> Option<PathBuf> {
    xdg_from(std::env::var_os(var))
}

/// An XDG var counts only when set to an absolute path, per the spec — a
/// relative value must be ignored rather than resolved against the cwd, or the
/// config lands somewhere different depending on where you ran the command.
fn xdg_from(raw: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let path = PathBuf::from(raw?);
    path.is_absolute().then_some(path)
}

pub const DEFAULT_PROFILE: &str = "default";
pub const DEFAULT_BASE_URL: &str = "http://localhost:8000";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_profile: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub profiles: BTreeMap<String, Profile>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Profile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,
}

impl Config {
    /// A missing file is an empty config, not an error — the CLI must work on
    /// a machine it has never run on.
    pub fn load(path: &Path) -> Result<Self> {
        let raw = match fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        toml::from_str(&raw).with_context(|| format!("parsing {}", path.display()))
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let body = toml::to_string_pretty(self).context("serializing config")?;
        fs::write(path, body).with_context(|| format!("writing {}", path.display()))
    }

    pub fn profile(&self, name: &str) -> Option<&Profile> {
        self.profiles.get(name)
    }

    pub fn profile_mut(&mut self, name: &str) -> &mut Profile {
        self.profiles.entry(name.to_string()).or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_an_empty_config() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(&dir.path().join("nope.toml")).unwrap();
        assert!(cfg.profiles.is_empty());
        assert!(cfg.default_profile.is_none());
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/config.toml");
        let mut cfg = Config {
            default_profile: Some("work".into()),
            ..Default::default()
        };
        cfg.profile_mut("work").base_url = Some("https://app.clawbits.ai".into());
        cfg.profile_mut("work").org = Some("org_1".into());
        cfg.save(&path).unwrap();

        let back = Config::load(&path).unwrap();
        assert_eq!(back.default_profile.as_deref(), Some("work"));
        assert_eq!(
            back.profile("work").unwrap().base_url.as_deref(),
            Some("https://app.clawbits.ai")
        );
    }

    #[test]
    fn relative_xdg_values_are_ignored() {
        assert_eq!(xdg_from(Some("relative/path".into())), None);
        assert_eq!(xdg_from(None), None);
        assert_eq!(
            xdg_from(Some("/abs/path".into())),
            Some(PathBuf::from("/abs/path"))
        );
    }

    #[test]
    fn config_and_sessions_live_in_separate_trees() {
        // The split is the whole point: config.toml is safe to sync, the
        // session file is not.
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::under(dir.path());
        assert_ne!(paths.config.parent(), paths.sessions.parent());
    }
}
