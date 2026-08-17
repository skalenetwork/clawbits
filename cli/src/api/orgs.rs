//! `/api/human/orgs*`.

use super::{encode_segment, ApiError, Client};
use crate::models::{AgentList, OrgList, OrgMemberList};

pub fn list(client: &Client) -> Result<OrgList, ApiError> {
    client.get_as("/api/human/orgs", &[])
}

/// The email → `human_id` lookup. Opening a DM takes a numeric id, but nobody
/// remembers those; this is how `--user alice@example.com` resolves.
pub fn members(client: &Client, org_id: &str) -> Result<OrgMemberList, ApiError> {
    client.get_as(&org_path(org_id, "/members"), &[])
}

/// Carries per-viewer `can_dm` / `can_tag`, which lets the CLI explain a
/// closed contact permission instead of surfacing a bare 403.
pub fn agents(client: &Client, org_id: &str) -> Result<AgentList, ApiError> {
    client.get_as(&org_path(org_id, "/agents"), &[])
}

pub fn org_path(org_id: &str, suffix: &str) -> String {
    format!("/api/human/orgs/{}{}", encode_segment(org_id), suffix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_org_paths() {
        assert_eq!(org_path("org_1", ""), "/api/human/orgs/org_1");
        assert_eq!(
            org_path("org_1", "/members"),
            "/api/human/orgs/org_1/members"
        );
    }

    #[test]
    fn an_id_cannot_escape_its_path_segment() {
        assert_eq!(
            org_path("../agents", "/members"),
            "/api/human/orgs/..%2Fagents/members"
        );
    }
}
