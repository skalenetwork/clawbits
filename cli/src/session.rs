//! Session-token storage: `sessions.toml`.
//!
//! This is the only module that puts a credential on disk, and the only one
//! that reads one back. Everything about it is deliberately narrow.
//!
//! # What the token is
//!
//! Clawbits has no human API key. The only human credential is the session
//! value the server also sets as a cookie — a Fernet-sealed WorkOS session, or
//! an HMAC blob from the dev-auth bypass. Both are returned in the JSON body of
//! their login endpoint as `token`, and the server's auth dependency takes
//! `Authorization: Bearer` in preference to the cookie for both, so a
//! non-browser client needs no cookie jar. `apps/mobile` works the same way.
//!
//! # Why the base URL is stored alongside it
//!
//! A token minted by one deployment is worthless to another and dangerous to
//! send there. Recording the origin lets [`SessionRecord::matches_base_url`]
//! refuse to hand a production session to a stray `--base-url`.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct SessionStore {
    #[serde(default)]
    pub sessions: BTreeMap<String, SessionRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub token: String,
    /// `"workos"` or `"dev"`. Informational — the server sniffs the token
    /// itself, trying the dev resolver first and falling through silently.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub human_id: Option<i64>,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

impl SessionRecord {
    pub fn matches_base_url(&self, base_url: &str) -> bool {
        normalize_base(&self.base_url) == normalize_base(base_url)
    }
}

fn normalize_base(url: &str) -> String {
    url.trim_end_matches('/').to_ascii_lowercase()
}

impl SessionStore {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = match fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        warn_if_permissive(path);
        toml::from_str(&raw).with_context(|| format!("parsing {}", path.display()))
    }

    pub fn get(&self, profile: &str) -> Option<&SessionRecord> {
        self.sessions.get(profile)
    }

    pub fn set(&mut self, profile: &str, record: SessionRecord) {
        self.sessions.insert(profile.to_string(), record);
    }

    pub fn remove(&mut self, profile: &str) -> bool {
        self.sessions.remove(profile).is_some()
    }

    pub fn clear(&mut self) {
        self.sessions.clear();
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let body = toml::to_string_pretty(self).context("serializing sessions")?;
        write_secret(path, &body)
    }
}

/// Write `body` to `path` with 0600, atomically.
///
/// The mode is set at `open` time rather than chmod-ed afterwards: a
/// create-then-chmod leaves the token world-readable for the width of the
/// race. The temp file is a sibling so the rename is atomic — across
/// filesystems it would not be.
#[cfg(unix)]
fn write_secret(path: &Path, body: &str) -> Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let dir = path
        .parent()
        .context("session path has no parent directory")?;
    fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("securing {}", dir.display()))?;

    let tmp = dir.join(format!(".sessions.toml.{}.tmp", std::process::id()));
    // create_new so we never write into a file someone else pre-created with
    // looser permissions.
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .with_context(|| format!("creating {}", tmp.display()))?;
    let write = (|| -> std::io::Result<()> {
        f.write_all(body.as_bytes())?;
        f.sync_all()
    })();
    if let Err(e) = write {
        let _ = fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("writing {}", tmp.display()));
    }
    drop(f);
    fs::rename(&tmp, path).with_context(|| format!("installing {}", path.display()))
}

#[cfg(not(unix))]
fn write_secret(path: &Path, body: &str) -> Result<()> {
    let dir = path
        .parent()
        .context("session path has no parent directory")?;
    fs::create_dir_all(dir)?;
    fs::write(path, body).with_context(|| format!("writing {}", path.display()))
}

/// Warn, don't fail: a umask-mangled file should still let you read your
/// messages. Failing closed here would be a support ticket, not a fix.
#[cfg(unix)]
fn warn_if_permissive(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = fs::metadata(path) {
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            eprintln!(
                "warning: {} is mode {:o}; it holds a session token. \
                 Fix with: chmod 600 {}",
                path.display(),
                mode,
                path.display()
            );
        }
    }
}

#[cfg(not(unix))]
fn warn_if_permissive(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(base: &str) -> SessionRecord {
        SessionRecord {
            token: "sealed-token".into(),
            kind: "dev".into(),
            email: Some("alice@example.com".into()),
            human_id: Some(7),
            base_url: base.into(),
            created_at: Some("2026-08-14T09:12:33Z".into()),
        }
    }

    #[test]
    fn round_trips_and_is_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/sessions.toml");
        let mut store = SessionStore::default();
        store.set("default", record("http://localhost:8000"));
        store.save(&path).unwrap();

        let back = SessionStore::load(&path).unwrap();
        assert_eq!(back.get("default").unwrap().token, "sealed-token");
        assert_eq!(back.get("default").unwrap().human_id, Some(7));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "session file must be owner-only, got {mode:o}");
            let dmode = fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(
                dmode, 0o700,
                "session dir must be owner-only, got {dmode:o}"
            );
        }
    }

    #[test]
    fn overwriting_an_existing_file_still_ends_owner_only() {
        // The temp-file dance must not degrade to a plain write on the second
        // save, which is the common path.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.toml");
        let mut store = SessionStore::default();
        store.set("default", record("http://localhost:8000"));
        store.save(&path).unwrap();
        store.set("other", record("https://app.clawbits.ai"));
        store.save(&path).unwrap();

        let back = SessionStore::load(&path).unwrap();
        assert_eq!(back.sessions.len(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn missing_file_is_an_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::load(&dir.path().join("nope.toml")).unwrap();
        assert!(store.sessions.is_empty());
    }

    #[test]
    fn base_url_match_ignores_trailing_slash_and_case() {
        let r = record("https://App.Clawbits.ai/");
        assert!(r.matches_base_url("https://app.clawbits.ai"));
        assert!(r.matches_base_url("https://app.clawbits.ai/"));
        // The point of the check: a different host must not get this token.
        assert!(!r.matches_base_url("https://evil.example"));
        assert!(!r.matches_base_url("http://localhost:8000"));
    }

    #[test]
    fn remove_and_clear() {
        let mut store = SessionStore::default();
        store.set("a", record("http://x"));
        store.set("b", record("http://x"));
        assert!(store.remove("a"));
        assert!(!store.remove("a"));
        store.clear();
        assert!(store.sessions.is_empty());
    }
}
