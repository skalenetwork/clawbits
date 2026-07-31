"""Tests for the agent contact-permission system.

Contact with an agent is **closed by default**: with no grant a principal (a
human or another agent) can neither open/access a DM with the agent nor
``@``-tag it / add it to a channel. The agent's operator is always allowed; an
operator or org owner can grant ``can_dm`` / ``can_tag`` to others.

These tests exercise the management API
(``/api/human/agents/{id}/contact-permissions``) and every enforcement point:
human↔agent DM, agent↔agent DM, channel tagging, add-member, and the per-viewer
``can_dm`` / ``can_tag`` flags the human agent payloads expose for the UI.
"""
from tests.fastapi.test_human_mattermost import (
    _agent_auth,
    _create_agent,
    _create_channel,
    _get_personal_org_id,
    _human_auth,
    _register_human,
)

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _add_org_member(tc, owner_token, org_id, email, role="member"):
    r = tc.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": email, "role": role},
        headers=_human_auth(owner_token),
    )
    assert r.status_code == 200, r.text


def _grant(tc, manager_token, agent_id, ptype, pid, *, can_dm=False, can_tag=False):
    return tc.put(
        f"/api/human/agents/{agent_id}/contact-permissions",
        json={
            "principal_type": ptype,
            "principal_id": str(pid),
            "can_dm": can_dm,
            "can_tag": can_tag,
        },
        headers=_human_auth(manager_token),
    )


def _open_dm(tc, token, org_id, agent_id):
    return tc.post(
        "/api/human/mm/direct",
        json={"org_id": org_id, "target_id": agent_id, "target_type": "agent"},
        headers=_human_auth(token),
    )


def _add_channel_member(tc, token, ch_id, member_id, member_type):
    return tc.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(member_id), "member_type": member_type},
        headers=_human_auth(token),
    )


def _post(tc, token, ch_id, message):
    return tc.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": message, "status": "published"},
        headers=_human_auth(token),
    )


# ---------------------------------------------------------------------------
# Human → agent DM
# ---------------------------------------------------------------------------


def test_human_dm_operator_always_allowed(test_client):
    """The operator never needs an explicit grant to DM its own agent."""
    owner = _register_human(test_client, "dm-op@test.com", display_name="Op")
    agent = _create_agent(test_client, owner_email="dm-op@test.com")
    org_id = _get_personal_org_id(test_client, owner["access_token"])

    r = _open_dm(test_client, owner["access_token"], org_id, agent["agent_id"])
    assert r.status_code == 200, r.text
    assert r.json()["channel_type"] == "direct"


def test_human_dm_denied_without_grant_then_allowed(test_client):
    """A non-operator org member can't DM the agent until granted ``can_dm``."""
    owner = _register_human(test_client, "dm-owner@test.com", display_name="Owner")
    other = _register_human(test_client, "dm-other@test.com", display_name="Other")
    agent = _create_agent(test_client, owner_email="dm-owner@test.com")
    org_id = _get_personal_org_id(test_client, owner["access_token"])
    _add_org_member(test_client, owner["access_token"], org_id, "dm-other@test.com")

    # Closed by default → 403.
    r = _open_dm(test_client, other["access_token"], org_id, agent["agent_id"])
    assert r.status_code == 403, r.text

    # Operator grants can_dm → now allowed.
    g = _grant(
        test_client, owner["access_token"], agent["agent_id"],
        "human", other["user"]["id"], can_dm=True,
    )
    assert g.status_code == 200, g.text

    r = _open_dm(test_client, other["access_token"], org_id, agent["agent_id"])
    assert r.status_code == 200, r.text
    dm_id = r.json()["channel_id"]

    # Revoking access shuts the existing DM too: neither re-open nor read.
    d = test_client.delete(
        f"/api/human/agents/{agent['agent_id']}/contact-permissions/human/{other['user']['id']}",
        headers=_human_auth(owner["access_token"]),
    )
    assert d.status_code == 200, d.text
    assert d.json()["removed"] is True

    r = _open_dm(test_client, other["access_token"], org_id, agent["agent_id"])
    assert r.status_code == 403, r.text
    r = test_client.get(
        f"/api/human/mm/channels/{dm_id}/posts", headers=_human_auth(other["access_token"])
    )
    assert r.status_code == 403, r.text


def test_revoked_agent_dm_drops_out_of_sidebar(test_client):
    """A revoked agent DM disappears from the human's channel list."""
    owner = _register_human(test_client, "side-owner@test.com", display_name="Owner")
    other = _register_human(test_client, "side-other@test.com", display_name="Other")
    agent = _create_agent(test_client, owner_email="side-owner@test.com")
    org_id = _get_personal_org_id(test_client, owner["access_token"])
    _add_org_member(test_client, owner["access_token"], org_id, "side-other@test.com")

    _grant(
        test_client, owner["access_token"], agent["agent_id"],
        "human", other["user"]["id"], can_dm=True,
    )
    dm_id = _open_dm(
        test_client, other["access_token"], org_id, agent["agent_id"]
    ).json()["channel_id"]

    r = test_client.get(
        "/api/human/mm/channels", headers=_human_auth(other["access_token"])
    )
    assert dm_id in [c["channel_id"] for c in r.json()["channels"]]

    test_client.delete(
        f"/api/human/agents/{agent['agent_id']}/contact-permissions/human/{other['user']['id']}",
        headers=_human_auth(owner["access_token"]),
    )
    r = test_client.get(
        "/api/human/mm/channels", headers=_human_auth(other["access_token"])
    )
    assert dm_id not in [c["channel_id"] for c in r.json()["channels"]]


# ---------------------------------------------------------------------------
# Org membership does not auto-join agent channels
# ---------------------------------------------------------------------------


def test_new_org_member_not_auto_joined_to_agent_channel(test_client):
    """Adding a member to an org with an agent must NOT drop them into that
    agent's channel — contact is closed by default."""
    owner = _register_human(test_client, "auto-owner@test.com", display_name="Owner")
    other = _register_human(test_client, "auto-other@test.com", display_name="Other")
    agent = _create_agent(test_client, owner_email="auto-owner@test.com")
    org_id = _get_personal_org_id(test_client, owner["access_token"])

    # The agent's default channel exists (operator fetched it).
    _add_org_member(test_client, owner["access_token"], org_id, "auto-other@test.com")

    # The new member's sidebar must not contain any agent channel.
    r = test_client.get(
        "/api/human/mm/channels", headers=_human_auth(other["access_token"])
    )
    assert r.status_code == 200, r.text
    names = [c.get("name", "") for c in r.json()["channels"]]
    assert not any(n.startswith(f"agent-{agent['agent_id']}") for n in names), names


# ---------------------------------------------------------------------------
# Channel tagging + add-member
# ---------------------------------------------------------------------------


def test_human_tag_denied_without_grant_then_publishes(test_client):
    """A non-operator can't tag the agent until granted; once granted the tag
    publishes immediately (approval was removed in favour of permissions)."""
    owner = _register_human(test_client, "tag-owner@test.com", display_name="Owner")
    other = _register_human(test_client, "tag-other@test.com", display_name="Other")
    agent = _create_agent(test_client, owner_email="tag-owner@test.com")
    org_id = _get_personal_org_id(test_client, owner["access_token"])
    _add_org_member(test_client, owner["access_token"], org_id, "tag-other@test.com")

    ch_id = _create_channel(test_client, owner["access_token"], "tag-room")["channel_id"]
    assert _add_channel_member(
        test_client, owner["access_token"], ch_id, other["user"]["id"], "human"
    ).status_code == 200
    assert _add_channel_member(
        test_client, owner["access_token"], ch_id, agent["agent_id"], "agent"
    ).status_code == 200

    msg = f"hey @{agent['agent_id']}"
    r = _post(test_client, other["access_token"], ch_id, msg)
    assert r.status_code == 403, r.text

    _grant(
        test_client, owner["access_token"], agent["agent_id"],
        "human", other["user"]["id"], can_tag=True,
    )
    r = _post(test_client, other["access_token"], ch_id, msg)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "published"

    # The operator may always tag too.
    r = _post(test_client, owner["access_token"], ch_id, msg)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "published"


def test_human_add_agent_member_denied_without_grant(test_client):
    """Bringing an agent into a channel needs the same ``can_tag`` grant."""
    owner = _register_human(test_client, "add-owner@test.com", display_name="Owner")
    other = _register_human(test_client, "add-other@test.com", display_name="Other")
    agent = _create_agent(test_client, owner_email="add-owner@test.com")
    org_id = _get_personal_org_id(test_client, owner["access_token"])
    _add_org_member(test_client, owner["access_token"], org_id, "add-other@test.com")

    ch_id = _create_channel(test_client, owner["access_token"], "add-room")["channel_id"]
    _add_channel_member(test_client, owner["access_token"], ch_id, other["user"]["id"], "human")

    r = _add_channel_member(test_client, other["access_token"], ch_id, agent["agent_id"], "agent")
    assert r.status_code == 403, r.text

    _grant(
        test_client, owner["access_token"], agent["agent_id"],
        "human", other["user"]["id"], can_tag=True,
    )
    r = _add_channel_member(test_client, other["access_token"], ch_id, agent["agent_id"], "agent")
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Agent → agent
# ---------------------------------------------------------------------------


def test_agent_to_agent_dm_requires_grant(test_client):
    """One agent can DM another only when the target's operator grants it; the
    recipient can still reply, and revoking shuts the DM for both."""
    owner = _register_human(test_client, "a2a@test.com", display_name="Owner")
    agent_a = _create_agent(test_client, owner_email="a2a@test.com")
    agent_b = _create_agent(test_client, owner_email="a2a@test.com")

    def open_dm(api_key, target):
        return test_client.post(
            "/api/agentic/mm/direct",
            json={"target_agent_id": target},
            headers=_agent_auth(api_key),
        )

    # Closed by default.
    r = open_dm(agent_a["api_key"], agent_b["agent_id"])
    assert r.status_code == 403, r.text

    # Operator of B grants A can_dm on B.
    g = _grant(
        test_client, owner["access_token"], agent_b["agent_id"],
        "agent", agent_a["agent_id"], can_dm=True,
    )
    assert g.status_code == 200, g.text

    r = open_dm(agent_a["api_key"], agent_b["agent_id"])
    assert r.status_code == 200, r.text
    dm_id = r.json()["channel_id"]

    # The recipient B (never granted to contact A) can still read + reply.
    r = test_client.get(
        f"/api/agentic/mm/channels/{dm_id}/posts", headers=_agent_auth(agent_b["api_key"])
    )
    assert r.status_code == 200, r.text
    r = test_client.post(
        f"/api/agentic/mm/channels/{dm_id}/posts",
        json={"message": "reply ok"},
        headers=_agent_auth(agent_b["api_key"]),
    )
    assert r.status_code == 200, r.text

    # Revoke → both sides lose access.
    test_client.delete(
        f"/api/human/agents/{agent_b['agent_id']}/contact-permissions/agent/{agent_a['agent_id']}",
        headers=_human_auth(owner["access_token"]),
    )
    r = test_client.get(
        f"/api/agentic/mm/channels/{dm_id}/posts", headers=_agent_auth(agent_a["api_key"])
    )
    assert r.status_code == 403, r.text
    r = test_client.get(
        f"/api/agentic/mm/channels/{dm_id}/posts", headers=_agent_auth(agent_b["api_key"])
    )
    assert r.status_code == 403, r.text


def test_agent_tagging_agent_requires_grant(test_client):
    """An agent can't ``@``-tag another agent in a channel without ``can_tag``."""
    owner = _register_human(test_client, "atag@test.com", display_name="Owner")
    agent_a = _create_agent(test_client, owner_email="atag@test.com")
    agent_b = _create_agent(test_client, owner_email="atag@test.com")
    ch_id = _create_channel(test_client, owner["access_token"], "atag-room")["channel_id"]
    # Operator owns both agents, so it can add both to the channel.
    assert _add_channel_member(
        test_client, owner["access_token"], ch_id, agent_a["agent_id"], "agent"
    ).status_code == 200
    assert _add_channel_member(
        test_client, owner["access_token"], ch_id, agent_b["agent_id"], "agent"
    ).status_code == 200

    msg = f"ping @{agent_b['agent_id']}"
    r = test_client.post(
        f"/api/agentic/mm/channels/{ch_id}/posts",
        json={"message": msg},
        headers=_agent_auth(agent_a["api_key"]),
    )
    assert r.status_code == 403, r.text

    _grant(
        test_client, owner["access_token"], agent_b["agent_id"],
        "agent", agent_a["agent_id"], can_tag=True,
    )
    r = test_client.post(
        f"/api/agentic/mm/channels/{ch_id}/posts",
        json={"message": msg},
        headers=_agent_auth(agent_a["api_key"]),
    )
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Management API
# ---------------------------------------------------------------------------


def test_management_authority_operator_owner_member(test_client):
    """Operator and org owner may manage contacts; a plain member may not."""
    owner = _register_human(test_client, "mg-owner@test.com", display_name="Owner")
    co_owner = _register_human(test_client, "mg-coowner@test.com", display_name="CoOwner")
    member = _register_human(test_client, "mg-member@test.com", display_name="Member")
    agent = _create_agent(test_client, owner_email="mg-owner@test.com")
    org_id = _get_personal_org_id(test_client, owner["access_token"])
    _add_org_member(test_client, owner["access_token"], org_id, "mg-coowner@test.com", role="owner")
    _add_org_member(test_client, owner["access_token"], org_id, "mg-member@test.com", role="member")

    url = f"/api/human/agents/{agent['agent_id']}/contact-permissions"
    assert test_client.get(url, headers=_human_auth(owner["access_token"])).status_code == 200
    assert test_client.get(url, headers=_human_auth(co_owner["access_token"])).status_code == 200
    assert test_client.get(url, headers=_human_auth(member["access_token"])).status_code == 403

    # Org owner can grant.
    g = _grant(
        test_client, co_owner["access_token"], agent["agent_id"],
        "human", member["user"]["id"], can_dm=True,
    )
    assert g.status_code == 200, g.text
    # Plain member cannot.
    g = _grant(
        test_client, member["access_token"], agent["agent_id"],
        "human", owner["user"]["id"], can_dm=True,
    )
    assert g.status_code == 403, g.text


def test_management_list_and_clear(test_client):
    """GET reflects grants; setting both surfaces false clears the row."""
    owner = _register_human(test_client, "lc-owner@test.com", display_name="Owner")
    other = _register_human(test_client, "lc-other@test.com", display_name="Other")
    agent = _create_agent(test_client, owner_email="lc-owner@test.com")
    org_id = _get_personal_org_id(test_client, owner["access_token"])
    _add_org_member(test_client, owner["access_token"], org_id, "lc-other@test.com")
    url = f"/api/human/agents/{agent['agent_id']}/contact-permissions"

    _grant(
        test_client, owner["access_token"], agent["agent_id"],
        "human", other["user"]["id"], can_dm=True, can_tag=True,
    )
    r = test_client.get(url, headers=_human_auth(owner["access_token"]))
    perms = r.json()["permissions"]
    assert len(perms) == 1
    assert perms[0]["principal_id"] == str(other["user"]["id"])
    assert perms[0]["can_dm"] and perms[0]["can_tag"]

    # Both false removes the grant entirely.
    _grant(
        test_client, owner["access_token"], agent["agent_id"],
        "human", other["user"]["id"], can_dm=False, can_tag=False,
    )
    r = test_client.get(url, headers=_human_auth(owner["access_token"]))
    assert r.json()["permissions"] == []


def test_management_rejects_non_org_member_and_self(test_client):
    """A human principal must be in the agent's org; an agent can't grant itself."""
    owner = _register_human(test_client, "rej-owner@test.com", display_name="Owner")
    outsider = _register_human(test_client, "rej-out@test.com", display_name="Outsider")
    agent = _create_agent(test_client, owner_email="rej-owner@test.com")

    g = _grant(
        test_client, owner["access_token"], agent["agent_id"],
        "human", outsider["user"]["id"], can_dm=True,
    )
    assert g.status_code == 400, g.text

    g = _grant(
        test_client, owner["access_token"], agent["agent_id"],
        "agent", agent["agent_id"], can_dm=True,
    )
    assert g.status_code == 400, g.text


# ---------------------------------------------------------------------------
# Per-viewer UI flags
# ---------------------------------------------------------------------------


def test_channel_members_expose_viewer_can_tag(test_client):
    """The human members payload carries per-viewer ``can_tag`` on agent rows so
    the composer can hide agents the viewer may not tag."""
    owner = _register_human(test_client, "ct-owner@test.com", display_name="Owner")
    other = _register_human(test_client, "ct-other@test.com", display_name="Other")
    agent = _create_agent(test_client, owner_email="ct-owner@test.com")
    org_id = _get_personal_org_id(test_client, owner["access_token"])
    _add_org_member(test_client, owner["access_token"], org_id, "ct-other@test.com")

    ch_id = _create_channel(test_client, owner["access_token"], "ct-room")["channel_id"]
    _add_channel_member(test_client, owner["access_token"], ch_id, other["user"]["id"], "human")
    _add_channel_member(test_client, owner["access_token"], ch_id, agent["agent_id"], "agent")

    def agent_can_tag(token):
        r = test_client.get(
            f"/api/human/mm/channels/{ch_id}/members", headers=_human_auth(token)
        )
        assert r.status_code == 200, r.text
        row = next(m for m in r.json()["members"] if m.get("agent_id") == agent["agent_id"])
        return row["can_tag"]

    # Operator may tag; a non-granted member may not.
    assert agent_can_tag(owner["access_token"]) is True
    assert agent_can_tag(other["access_token"]) is False

    _grant(
        test_client, owner["access_token"], agent["agent_id"],
        "human", other["user"]["id"], can_tag=True,
    )
    assert agent_can_tag(other["access_token"]) is True


def test_agent_payload_exposes_viewer_contact_flags(test_client):
    """The agents-list / profile payloads carry the viewer's can_dm/can_tag."""
    owner = _register_human(test_client, "fl-owner@test.com", display_name="Owner")
    other = _register_human(test_client, "fl-other@test.com", display_name="Other")
    agent = _create_agent(test_client, owner_email="fl-owner@test.com")
    org_id = _get_personal_org_id(test_client, owner["access_token"])
    _add_org_member(test_client, owner["access_token"], org_id, "fl-other@test.com")

    def profile(token):
        r = test_client.get(
            f"/api/human/orgs/{org_id}/agents/{agent['agent_id']}",
            headers=_human_auth(token),
        )
        assert r.status_code == 200, r.text
        return r.json()

    # Operator: everything true.
    p = profile(owner["access_token"])
    assert p["can_dm"] and p["can_tag"] and p["can_manage_contacts"]

    # Plain member: all false before any grant.
    p = profile(other["access_token"])
    assert not p["can_dm"] and not p["can_tag"] and not p["can_manage_contacts"]

    # Grant can_dm only → reflected in both list and profile.
    _grant(
        test_client, owner["access_token"], agent["agent_id"],
        "human", other["user"]["id"], can_dm=True,
    )
    p = profile(other["access_token"])
    assert p["can_dm"] and not p["can_tag"]

    r = test_client.get(
        f"/api/human/orgs/{org_id}/agents", headers=_human_auth(other["access_token"])
    )
    row = next(a for a in r.json()["agents"] if a["agent_id"] == agent["agent_id"])
    assert row["can_dm"] and not row["can_tag"] and not row["can_manage_contacts"]


# ---------------------------------------------------------------------------
# Revocation closes the agent side and search too (P1a / P1b)
# ---------------------------------------------------------------------------


def _open_agent_dm(test_client, owner, owner_email, other_email):
    """Grant + open an agent DM for a non-operator human; return (other, agent, dm_id)."""
    other = _register_human(test_client, other_email, display_name="Other")
    agent = _create_agent(test_client, owner_email=owner_email)
    org_id = _get_personal_org_id(test_client, owner["access_token"])
    _add_org_member(test_client, owner["access_token"], org_id, other_email)
    _grant(
        test_client, owner["access_token"], agent["agent_id"],
        "human", other["user"]["id"], can_dm=True,
    )
    dm_id = _open_dm(
        test_client, other["access_token"], org_id, agent["agent_id"]
    ).json()["channel_id"]
    return other, agent, dm_id


def test_revoke_closes_agent_side_of_human_dm(test_client):
    """After a human's ``can_dm`` is revoked the agent also loses access to the
    DM (read + channel list), not just the human."""
    owner = _register_human(test_client, "rv-owner@test.com", display_name="Owner")
    _other, agent, dm_id = _open_agent_dm(
        test_client, owner, "rv-owner@test.com", "rv-other@test.com"
    )

    # While granted, the agent can read the DM and sees it in its channel list.
    r = test_client.get(
        f"/api/agentic/mm/channels/{dm_id}/posts", headers=_agent_auth(agent["api_key"])
    )
    assert r.status_code == 200, r.text
    r = test_client.get("/api/agentic/mm/channels", headers=_agent_auth(agent["api_key"]))
    assert dm_id in [c["channel_id"] for c in r.json()["channels"]]

    # Revoke → the agent can no longer read/post the DM, and it drops out of
    # the agent's channel list.
    test_client.delete(
        f"/api/human/agents/{agent['agent_id']}/contact-permissions/human/{_other['user']['id']}",
        headers=_human_auth(owner["access_token"]),
    )
    r = test_client.get(
        f"/api/agentic/mm/channels/{dm_id}/posts", headers=_agent_auth(agent["api_key"])
    )
    assert r.status_code == 403, r.text
    r = test_client.post(
        f"/api/agentic/mm/channels/{dm_id}/posts",
        json={"message": "still there?"},
        headers=_agent_auth(agent["api_key"]),
    )
    assert r.status_code == 403, r.text
    r = test_client.get("/api/agentic/mm/channels", headers=_agent_auth(agent["api_key"]))
    assert dm_id not in [c["channel_id"] for c in r.json()["channels"]]

    # The operator DM is unaffected (operator is always allowed).
    r = test_client.get(
        f"/api/agentic/mm/teams/{agent['agent_id']}/operator-channel",
        headers=_agent_auth(agent["api_key"]),
    )
    op_ch = r.json()["channel_id"]
    r = test_client.get(
        f"/api/agentic/mm/channels/{op_ch}/posts", headers=_agent_auth(agent["api_key"])
    )
    assert r.status_code == 200, r.text


def test_revoked_agent_dm_content_not_searchable(test_client):
    """A revoked human can't surface the DM's content via search even though
    the lingering membership row remains."""
    owner = _register_human(test_client, "sr-owner@test.com", display_name="Owner")
    other, agent, dm_id = _open_agent_dm(
        test_client, owner, "sr-owner@test.com", "sr-other@test.com"
    )

    needle = "zubzubmarmot"
    r = test_client.post(
        f"/api/human/mm/channels/{dm_id}/posts",
        json={"message": f"a secret {needle} here", "status": "published"},
        headers=_human_auth(other["access_token"]),
    )
    assert r.status_code == 200, r.text

    def search_hits(token):
        r = test_client.get(
            "/api/human/mm/search",
            params={"q": needle},
            headers=_human_auth(token),
        )
        assert r.status_code == 200, r.text
        return r.json()["results"]

    # Granted: the author finds the (uniquely-tokened) DM message.
    assert len(search_hits(other["access_token"])) >= 1

    # Revoke → search no longer returns it for that human.
    test_client.delete(
        f"/api/human/agents/{agent['agent_id']}/contact-permissions/human/{other['user']['id']}",
        headers=_human_auth(owner["access_token"]),
    )
    assert search_hits(other["access_token"]) == []


# ---------------------------------------------------------------------------
# Deleting a granted/granting principal doesn't break (P1c)
# ---------------------------------------------------------------------------


def test_delete_agent_with_contact_grants(test_client):
    """Deleting an agent referenced by contact grants succeeds and clears them."""
    from sqlmodel import Session

    from clawbits.db.table_write import TableWrite

    owner = _register_human(test_client, "da-owner@test.com", display_name="Owner")
    other = _register_human(test_client, "da-other@test.com", display_name="Other")
    victim = _create_agent(test_client, owner_email="da-owner@test.com")
    survivor = _create_agent(test_client, owner_email="da-owner@test.com")
    org_id = _get_personal_org_id(test_client, owner["access_token"])
    _add_org_member(test_client, owner["access_token"], org_id, "da-other@test.com")

    # victim is a principal who may DM survivor; a human may tag victim.
    _grant(
        test_client, owner["access_token"], survivor["agent_id"],
        "agent", victim["agent_id"], can_dm=True,
    )
    _grant(
        test_client, owner["access_token"], victim["agent_id"],
        "human", other["user"]["id"], can_tag=True,
    )

    with Session(test_client.app._engine) as db:
        TableWrite.delete_agent(db, victim["agent_id"])  # must not FK-error
        db.commit()

    # The grant that named the deleted agent as a principal is gone.
    r = test_client.get(
        f"/api/human/agents/{survivor['agent_id']}/contact-permissions",
        headers=_human_auth(owner["access_token"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["permissions"] == []


def test_delete_human_with_contact_grants(test_client):
    """Deleting a human who is a granted principal AND authored grants succeeds:
    grants naming them are dropped; grants they created survive (attribution
    cleared)."""
    from sqlmodel import Session

    from clawbits.db.table_write import TableWrite

    owner = _register_human(test_client, "dh-owner@test.com", display_name="Owner")
    coowner = _register_human(test_client, "dh-coowner@test.com", display_name="CoOwner")
    third = _register_human(test_client, "dh-third@test.com", display_name="Third")
    agent = _create_agent(test_client, owner_email="dh-owner@test.com")
    org_id = _get_personal_org_id(test_client, owner["access_token"])
    _add_org_member(test_client, owner["access_token"], org_id, "dh-coowner@test.com", role="owner")
    _add_org_member(test_client, owner["access_token"], org_id, "dh-third@test.com")

    # coowner (org owner) authors a grant for `third`; coowner is also granted.
    _grant(
        test_client, coowner["access_token"], agent["agent_id"],
        "human", third["user"]["id"], can_dm=True,
    )
    _grant(
        test_client, owner["access_token"], agent["agent_id"],
        "human", coowner["user"]["id"], can_dm=True,
    )

    with Session(test_client.app._engine) as db:
        TableWrite.delete_human_user(db, coowner["user"]["id"])  # must not FK-error
        db.commit()

    r = test_client.get(
        f"/api/human/agents/{agent['agent_id']}/contact-permissions",
        headers=_human_auth(owner["access_token"]),
    )
    assert r.status_code == 200, r.text
    pids = {p["principal_id"] for p in r.json()["permissions"]}
    assert str(third["user"]["id"]) in pids       # coowner's grant survives
    assert str(coowner["user"]["id"]) not in pids  # grant naming coowner removed


def test_deleted_agent_tombstone_does_not_shadow_dm_peer(test_client, _test_engine):
    """A ``deleted-agent`` tombstone member must not turn a human<->agent DM
    into a closed agent<->agent DM (or gate the human behind a grant for the
    sentinel).

    Regression: a reef signup reused an operator channel that once housed a
    since-deleted agent; the lingering sentinel member made ``dm_agent_peer``
    / ``can_agent_access_dm`` resolve the tombstone as the "agent peer", so
    the NEW agent's greeting and every human read 403'd
    ("Not permitted to contact this agent") on their own channel.
    """
    from sqlmodel import Session

    from clawbits.db.models import MmChannelMember
    from clawbits.db.table_write import DELETED_AGENT_ID, TableWrite

    _register_human(test_client, "dm-tomb@test.com", display_name="Tomb")
    agent = _create_agent(test_client, owner_email="dm-tomb@test.com")
    owner_token = _register_human(test_client, "dm-tomb@test.com")["access_token"]
    org_id = _get_personal_org_id(test_client, owner_token)

    r = _open_dm(test_client, owner_token, org_id, agent["agent_id"])
    assert r.status_code == 200, r.text
    dm_id = r.json()["channel_id"]

    # Simulate the aftermath of an earlier agent deletion in this channel
    # (the deletion flow re-points membership at the shared sentinel row).
    with Session(_test_engine) as db:
        TableWrite._get_or_create_deleted_agent(db)
        db.add(MmChannelMember(channel_id=dm_id, agent_id=DELETED_AGENT_ID))
        db.commit()

    # The live agent can still post to its operator DM...
    r = test_client.post(
        f"/api/agentic/mm/channels/{dm_id}/posts",
        json={"message": "hi from beyond the tombstone", "status": "streaming"},
        headers=_agent_auth(agent["api_key"]),
    )
    assert r.status_code == 200, r.text

    # ...and the operator can still read it.
    r = test_client.get(
        f"/api/human/mm/channels/{dm_id}/posts",
        headers=_human_auth(owner_token),
    )
    assert r.status_code == 200, r.text
