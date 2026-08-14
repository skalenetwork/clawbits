//! Turning what a person types into the ids the API wants.
//!
//! The API speaks in opaque ids — `channel_id`, `org_id`, numeric `human_id`.
//! People speak in `#general`, `acme`, `alice@example.com`. Everything in this
//! module bridges the two, and every failure names the alternatives rather than
//! just saying "not found".

use anyhow::{anyhow, bail, Result};

use crate::api::{mm, orgs, ApiError, Client};
use crate::models::{Agent, Channel, Org};
use crate::settings::Settings;

/// Commands that are org-scoped need one, and "which org?" has no safe guess.
pub fn require_org(settings: &Settings) -> Result<String> {
    settings.org.clone().ok_or_else(|| {
        anyhow!(
            "no organization selected.\n  \
             Pick one with: clawbits orgs use <ORG>\n  \
             Or pass --org <ORG_ID|NAME> / set CLAWBITS_ORG.\n  \
             List them with: clawbits orgs"
        )
    })
}

/// Resolve a channel by id, name, `#name`, or display name.
///
/// Scoped to the selected org when there is one; otherwise every channel the
/// caller belongs to, so this still works before `orgs use`.
pub fn channel(client: &Client, settings: &Settings, needle: &str) -> Result<Channel> {
    let wanted = needle.trim().trim_start_matches('#');
    if wanted.is_empty() {
        bail!("empty channel name");
    }

    let listing = mm::channels(client, settings.org.as_deref())?;
    let channels = listing.channels;

    if let Some(hit) = channels.iter().find(|c| c.channel_id == wanted) {
        return Ok(hit.clone());
    }
    if let Some(hit) = channels.iter().find(|c| c.name == wanted) {
        return Ok(hit.clone());
    }

    let ci = |a: &str| a.eq_ignore_ascii_case(wanted);
    let exact: Vec<&Channel> = channels
        .iter()
        .filter(|c| ci(&c.name) || c.display_name.as_deref().is_some_and(ci))
        .collect();
    if exact.len() == 1 {
        return Ok(exact[0].clone());
    }
    if exact.len() > 1 {
        bail!(
            "{}",
            ambiguous("channel", wanted, exact.iter().map(|c| c.label()))
        );
    }

    let lower = wanted.to_lowercase();
    let partial: Vec<&Channel> = channels
        .iter()
        .filter(|c| {
            c.name.to_lowercase().contains(&lower)
                || c.display_name
                    .as_deref()
                    .is_some_and(|d| d.to_lowercase().contains(&lower))
        })
        .collect();
    match partial.len() {
        1 => Ok(partial[0].clone()),
        0 => Err(not_found(format!(
            "no channel matching {wanted:?}{}.\n  List them with: clawbits channels",
            match &settings.org {
                Some(o) => format!(" in org {o}"),
                None => String::new(),
            }
        ))),
        _ => bail!(
            "{}",
            ambiguous("channel", wanted, partial.iter().map(|c| c.label()))
        ),
    }
}

/// Resolve an org by id, name, or display name.
pub fn org(client: &Client, needle: &str) -> Result<Org> {
    let wanted = needle.trim();
    let listing = orgs::list(client)?;
    let all = listing.organizations;

    if let Some(hit) = all.iter().find(|o| o.org_id == wanted) {
        return Ok(hit.clone());
    }
    let ci = |a: &str| a.eq_ignore_ascii_case(wanted);
    let matches: Vec<&Org> = all
        .iter()
        .filter(|o| ci(&o.name) || o.display_name.as_deref().is_some_and(ci))
        .collect();
    match matches.len() {
        1 => Ok(matches[0].clone()),
        0 => Err(not_found(format!(
            "no organization matching {wanted:?}.\n  List them with: clawbits orgs"
        ))),
        _ => bail!(
            "{}",
            ambiguous(
                "organization",
                wanted,
                matches.iter().map(|o| o.label().to_string())
            )
        ),
    }
}

/// Resolve a person to the numeric `human_id` the DM endpoint requires.
///
/// Accepts the id itself, an email, or a display name — the id is what the API
/// takes, but nobody knows theirs.
pub fn human_id(client: &Client, org_id: &str, needle: &str) -> Result<i64> {
    let wanted = needle.trim();
    if let Ok(id) = wanted.parse::<i64>() {
        return Ok(id);
    }

    let listing = orgs::members(client, org_id)?;
    let members = listing.members;

    let ci = |a: &str| a.eq_ignore_ascii_case(wanted);
    if let Some(hit) = members.iter().find(|m| ci(&m.email)) {
        return Ok(hit.human_id);
    }
    let by_name: Vec<_> = members
        .iter()
        .filter(|m| m.display_name.as_deref().is_some_and(ci))
        .collect();
    match by_name.len() {
        1 => Ok(by_name[0].human_id),
        0 => Err(not_found(format!(
            "no member of this organization matching {wanted:?}.\n  \
             Try their email, or list members with: clawbits raw GET /api/human/orgs/{org_id}/members"
        ))),
        _ => bail!(
            "{}",
            ambiguous(
                "member",
                wanted,
                by_name.iter().map(|m| format!(
                    "{} <{}>",
                    m.display_name.clone().unwrap_or_default(),
                    m.email
                ))
            )
        ),
    }
}

/// Look up an agent and check the caller may DM it.
///
/// Contact is closed by default, so the common failure is a permissions gap
/// rather than a typo. Catching it here turns a bare 403 into something with a
/// next step.
pub fn agent_for_dm(client: &Client, org_id: &str, needle: &str) -> Result<Agent> {
    let wanted = needle.trim();
    let listing = orgs::agents(client, org_id)?;
    let agents = listing.agents;

    let ci = |a: &str| a.eq_ignore_ascii_case(wanted);
    let hit = agents
        .iter()
        .find(|a| a.agent_id == wanted)
        .or_else(|| {
            agents.iter().find(|a| {
                a.nickname.as_deref().is_some_and(ci) || a.display_name.as_deref().is_some_and(ci)
            })
        })
        .ok_or_else(|| {
            not_found(format!(
                "no agent matching {wanted:?} in this organization.\n  \
                 List them with: clawbits raw GET /api/human/orgs/{org_id}/agents"
            ))
        })?;

    if !hit.can_dm {
        bail!(
            "you are not permitted to DM {}.\n  \
             Agent contact is closed by default — ask its operator to grant you `can_dm`.",
            hit.label()
        );
    }
    Ok(hit.clone())
}

/// A name that resolves to nothing is a not-found, and must exit 5 just like a
/// server 404 would. From where the user stands the two are the same event —
/// "that channel isn't there" — so they should not produce different exit codes
/// depending on whether the CLI or the server noticed first.
fn not_found(message: String) -> anyhow::Error {
    ApiError::NotFound(message).into()
}

fn ambiguous(kind: &str, needle: &str, options: impl Iterator<Item = String>) -> String {
    let mut listed: Vec<String> = options.collect();
    listed.sort();
    listed.dedup();
    format!(
        "{needle:?} matches more than one {kind}:\n  {}\n  Use the exact name or id.",
        listed.join("\n  ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::ColorMode;
    use std::time::Duration;

    fn settings(org: Option<&str>) -> Settings {
        Settings {
            base_url: "http://localhost:8000".into(),
            profile: "default".into(),
            org: org.map(str::to_string),
            json: false,
            color: ColorMode::Never,
            timeout: Duration::from_secs(30),
            verbose: false,
        }
    }

    #[test]
    fn require_org_explains_how_to_set_one() {
        let err = require_org(&settings(None)).unwrap_err().to_string();
        assert!(err.contains("clawbits orgs use"), "{err}");
        assert!(err.contains("--org"), "{err}");
        assert_eq!(require_org(&settings(Some("org_1"))).unwrap(), "org_1");
    }

    #[test]
    fn ambiguity_lists_the_candidates_sorted_and_deduped() {
        let msg = ambiguous(
            "channel",
            "eng",
            [
                "#eng-b".to_string(),
                "#eng-a".to_string(),
                "#eng-a".to_string(),
            ]
            .into_iter(),
        );
        assert!(msg.contains("more than one channel"), "{msg}");
        let a = msg.find("#eng-a").unwrap();
        let b = msg.find("#eng-b").unwrap();
        assert!(a < b, "candidates should be sorted:\n{msg}");
        assert_eq!(msg.matches("#eng-a").count(), 1, "deduped:\n{msg}");
    }
}
