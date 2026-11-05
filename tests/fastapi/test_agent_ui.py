"""Agent UI surfaces on posts (AGENT_UI_A2UI_PLAN S1, S2, S4): an agent posts an A2UI surface whose
text fallback the server writes, closes its own surface, and nobody edits a surface's text. A human's
click posts the action the server builds as their reply, with a form's checked values, and closes a
``once`` surface that then keeps them."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from clawbits.db.models import MmPost
from clawbits.realtime import channel_topic, human_topic
from tests.fastapi.test_agent_contact_permissions import _add_channel_member, _grant
from tests.fastapi.test_human_mattermost import (
    _add_human_to_org,
    _add_member,
    _bearer,
    _channel_row,
    _create_agent,
    _create_channel,
    _get_personal_org_id,
    _open_dm,
    _register_human,
)
from tests.fastapi.test_live_activity import FakeBus

CARD = [
    {"id": "root", "component": "Card", "child": "body"},
    {"id": "body", "component": "Column", "children": ["title", "stats", "docs"]},
    {"id": "title", "component": "Text", "text": "**Deploys this week**"},
    {"id": "stats", "component": "Stats", "items": [{"label": "Succeeded", "value": "9", "unit": "of 10"}]},
    {
        "id": "docs",
        "component": "Button",
        "child": "docs_label",
        "action": {"functionCall": {"@call": "openUrl", "args": {"url": "https://example.com/runs"}}},
    },
    {"id": "docs_label", "component": "Text", "text": "All runs"},
]
CARD_TEXT = "**Deploys this week**\nSucceeded: 9 of 10\nAll runs (https://example.com/runs)"


@pytest.fixture
def chat(test_client: TestClient) -> tuple[dict, dict, str]:
    human = _register_human(test_client, "surface@test.com", display_name="Surface")
    agent = _create_agent(test_client, owner_email="surface@test.com")
    channel_id = _create_channel(test_client, human["access_token"], "surfaces")["channel_id"]
    _add_member(test_client, human["access_token"], channel_id, agent["agent_id"], "agent")
    return human, agent, channel_id


@pytest.fixture
def fake_bus(monkeypatch: pytest.MonkeyPatch) -> FakeBus:
    from clawbits.realtime import bus as bus_module

    fake = FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    return fake


def _send(tc: TestClient, agent: dict, channel_id: str, body: dict):
    return tc.post(f"/api/agentic/mm/channels/{channel_id}/posts", json=body, headers=_bearer(agent["api_key"]))


def _surface(tc: TestClient, agent: dict, channel_id: str, components: list[dict] = CARD, **fields) -> dict:
    r = _send(tc, agent, channel_id, {"surface": {"components": components}, **fields})
    assert r.status_code == 200, r.text
    return r.json()


def _close(tc: TestClient, agent: dict, post_id: int, text: str = "Done"):
    return tc.post(f"/api/agentic/mm/posts/{post_id}/ui/close", json={"text": text}, headers=_bearer(agent["api_key"]))


def _posts_in(engine, channel_id: str) -> list[MmPost]:
    with Session(engine) as db:
        return list(db.exec(select(MmPost).where(MmPost.channel_id == channel_id)).all())


def test_a_surface_post_keeps_the_envelope_and_its_fallback(test_client, _test_engine, chat, fake_bus):
    human, agent, channel_id = chat
    fake_bus.presence.clear()

    post = _surface(test_client, agent, channel_id)

    surface_id = f"post-{post['post_id']}"
    assert post["message"] == CARD_TEXT
    assert post["ui"] == {
        "a2ui": {
            "version": "1.0",
            "createSurface": {
                "surfaceId": surface_id,
                "catalogId": "https://clawbits.ai/a2ui/chat/v1",
                "components": CARD,
                "dataModel": {},
            },
        },
        "rev": 0,
        "once": True,
        "closed": None,
    }
    (row,) = _posts_in(_test_engine, channel_id)
    assert row.ui == post["ui"]
    assert row.message == CARD_TEXT
    created = [e for _, e in fake_bus.published if e["type"] == "post.created"]
    assert created and all(e["data"]["ui"] == post["ui"] for e in created)
    assert fake_bus.presence == []
    as_agent = test_client.get(f"/api/agentic/mm/channels/{channel_id}/posts", headers=_bearer(agent["api_key"]))
    as_human = test_client.get(f"/api/human/mm/channels/{channel_id}/posts", headers=_bearer(human["access_token"]))
    assert as_agent.json()["posts"][0]["ui"] == as_human.json()["posts"][0]["ui"] == post["ui"]


def test_an_invalid_surface_is_a_422_of_spec_errors(test_client, _test_engine, chat):
    _, agent, channel_id = chat
    bad = [{"id": "root", "component": "Text", "text": "hi", "color": "red"}]

    r = _send(test_client, agent, channel_id, {"surface": {"components": bad}})

    assert r.status_code == 422, r.text
    assert r.json()["detail"] == [
        {
            "version": "1.0",
            "error": {
                "code": "VALIDATION_FAILED",
                "surfaceId": "post-new",
                "path": "/components/0/color",
                "message": "Text has no property 'color'.",
            },
        }
    ]
    missing_root = _send(test_client, agent, channel_id, {"surface": {"components": [{"id": "a", "component": "Divider"}]}})
    assert missing_root.status_code == 422
    assert missing_root.json()["detail"][0]["error"]["code"] == "INTEGRITY_ERROR"
    assert _posts_in(_test_engine, channel_id) == []


@pytest.mark.parametrize(
    "fields",
    [{"message": "hi"}, {"status": "streaming"}, {"file_ids": ["f1"]}],
)
def test_a_surface_post_takes_no_message_files_or_stream(test_client, chat, fields):
    _, agent, channel_id = chat
    r = _send(test_client, agent, channel_id, {"surface": {"components": CARD}, **fields})
    assert r.status_code == 422, r.text


def test_the_human_route_refuses_a_surface(test_client, _test_engine, chat):
    human, _, channel_id = chat
    r = test_client.post(
        f"/api/human/mm/channels/{channel_id}/posts",
        json={"message": "hi", "surface": {"components": CARD}},
        headers=_bearer(human["access_token"]),
    )
    assert r.status_code == 422, r.text
    assert _posts_in(_test_engine, channel_id) == []


def test_can_tag_reads_the_fallback(test_client):
    owner = _register_human(test_client, "surface-tag@test.com", display_name="Owner")
    agent_a = _create_agent(test_client, owner_email="surface-tag@test.com")
    agent_b = _create_agent(test_client, owner_email="surface-tag@test.com")
    channel_id = _create_channel(test_client, owner["access_token"], "surface-tags")["channel_id"]
    for agent in (agent_a, agent_b):
        assert _add_channel_member(
            test_client, owner["access_token"], channel_id, agent["agent_id"], "agent"
        ).status_code == 200
    tagging = [{"id": "root", "component": "Text", "text": f"ping @{agent_b['agent_id']}"}]

    assert _send(test_client, agent_a, channel_id, {"surface": {"components": tagging}}).status_code == 403
    _grant(test_client, owner["access_token"], agent_b["agent_id"], "agent", agent_a["agent_id"], can_tag=True)
    assert _surface(test_client, agent_a, channel_id, tagging)["message"] == f"ping @{agent_b['agent_id']}"


def test_a_keyed_surface_create_replays(test_client, _test_engine, chat):
    _, agent, channel_id = chat
    first = _surface(test_client, agent, channel_id, client_key="intent-ui:0")
    again = _surface(test_client, agent, channel_id, client_key="intent-ui:0")
    assert again == first
    assert len(_posts_in(_test_engine, channel_id)) == 1


def test_close_is_idempotent_and_emits_once(test_client, chat, fake_bus):
    human, agent, channel_id = chat
    post = _surface(test_client, agent, channel_id)
    fake_bus.published.clear()

    first = _close(test_client, agent, post["post_id"], "Chose: staging")
    again = _close(test_client, agent, post["post_id"], "Something else")

    assert first.status_code == again.status_code == 200, again.text
    ui = first.json()["ui"]
    assert (ui["rev"], ui["closed"]["text"]) == (1, "Chose: staging")
    assert ui["closed"]["at"].endswith("Z")
    assert again.json()["ui"] == ui
    updates = [e for _, e in fake_bus.published if e["type"] == "post.updated"]
    assert [u["data"]["ui"] for u in updates] == [ui]
    read = test_client.get(f"/api/human/mm/channels/{channel_id}/posts", headers=_bearer(human["access_token"]))
    assert read.json()["posts"][0]["ui"] == ui


def test_only_the_author_closes_its_own_surface(test_client, chat):
    human, agent, channel_id = chat
    other = _create_agent(test_client, owner_email="surface@test.com")
    _add_member(test_client, human["access_token"], channel_id, other["agent_id"], "agent")
    post = _surface(test_client, agent, channel_id)
    text_post = _send(test_client, agent, channel_id, {"message": "plain"}).json()

    assert _close(test_client, other, post["post_id"]).status_code == 403
    assert _close(test_client, agent, text_post["post_id"]).status_code == 409
    assert _close(test_client, agent, 9_999_999).status_code == 404
    outsider = _create_agent(test_client, owner_email="surface@test.com")
    assert _close(test_client, outsider, post["post_id"]).status_code == 403


def test_a_surface_refuses_edits(test_client, _test_engine, chat):
    human, agent, channel_id = chat
    post = _surface(test_client, agent, channel_id)

    by_human = test_client.patch(
        f"/api/human/mm/posts/{post['post_id']}", json={"message": "edited"}, headers=_bearer(human["access_token"])
    )
    by_agent = test_client.patch(
        f"/api/agentic/mm/channels/{channel_id}/posts/{post['post_id']}",
        json={"replace": "edited", "done": True},
        headers=_bearer(agent["api_key"]),
    )

    assert by_human.status_code == 403, by_human.text
    assert by_agent.status_code == 409, by_agent.text
    (row,) = _posts_in(_test_engine, channel_id)
    assert row.message == CARD_TEXT


CHOICE = [
    {"id": "root", "component": "Column", "children": ["ask", "pick", "go", "docs"]},
    {"id": "ask", "component": "Text", "text": "Deploy where?"},
    {
        "id": "pick",
        "component": "ChoicePicker",
        "options": [{"label": "Staging", "value": "staging"}, {"label": "Production", "value": "production"}],
        "value": {"@path": "/target"},
        "variant": "mutuallyExclusive",
    },
    {
        "id": "go",
        "component": "Button",
        "child": "go_label",
        "action": {"event": {"name": "deploy", "context": {"target": {"@path": "/target"}, "build": 812}}},
    },
    {"id": "go_label", "component": "Text", "text": "Deploy"},
    {
        "id": "docs",
        "component": "Button",
        "child": "docs_label",
        "action": {"functionCall": {"@call": "openUrl", "args": {"url": "https://example.com/runs"}}},
    },
    {"id": "docs_label", "component": "Text", "text": "All runs"},
]


def _choice(tc: TestClient, agent: dict, channel_id: str, **surface) -> dict:
    r = _send(tc, agent, channel_id, {"surface": {"components": CHOICE, "dataModel": {"target": []}, **surface}})
    assert r.status_code == 200, r.text
    return r.json()


def _click(
    tc: TestClient,
    human: dict,
    surface: dict,
    *,
    rev: int = 0,
    source: str = "go",
    bound: dict | None = None,
    key: str = "k1",
):
    return tc.post(
        f"/api/human/mm/posts/{surface['post_id']}/ui/actions",
        json={
            "rev": rev,
            "sourceComponentId": source,
            "bound": {"target": ["production"]} if bound is None else bound,
            "client_key": key,
        },
        headers=_bearer(human["access_token"]),
    )


def _member(tc: TestClient, owner: dict, channel_id: str, email: str) -> dict:
    member = _register_human(tc, email, display_name="Member")
    _add_human_to_org(tc, owner["access_token"], email)
    _add_member(tc, owner["access_token"], channel_id, member["user"]["id"])
    return member


def _ui_of(engine, post_id: int) -> dict:
    with Session(engine) as db:
        return db.get(MmPost, post_id).ui


def _channel_events(bus: FakeBus, channel_id: str) -> list[tuple[str, int]]:
    return [(e["type"], e["data"]["post_id"]) for topic, e in bus.published if topic == channel_topic(channel_id)]


def test_a_click_posts_the_action_and_closes_the_surface(test_client, _test_engine, chat, fake_bus):
    human, agent, channel_id = chat
    surface = _choice(test_client, agent, channel_id)
    fake_bus.published.clear()

    r = _click(test_client, human, surface)

    assert r.status_code == 200, r.text
    post = r.json()
    assert (post["human_id"], post["parent_post_id"], post["message"]) == (
        human["user"]["id"], surface["post_id"], "Deploy: Production"
    )
    assert (post["parent_preview"]["agent_id"], post["parent_preview"]["message_excerpt"]) == (
        agent["agent_id"], "Deploy where?"
    )
    action = dict(post["ui_action"])
    assert action.pop("timestamp").endswith("Z")
    assert action == {
        "name": "deploy",
        "surfaceId": f"post-{surface['post_id']}",
        "sourceComponentId": "go",
        "userMessage": None,
        "context": {"target": ["production"], "build": 812},
    }
    ui = _ui_of(_test_engine, surface["post_id"])
    assert (ui["rev"], ui["closed"]["text"]) == (1, "Deploy: Production")
    assert _channel_events(fake_bus, channel_id) == [
        ("post.created", post["post_id"]),
        ("post.updated", surface["post_id"]),
    ]
    updated = next(e for _, e in fake_bus.published if e["type"] == "post.updated")
    assert updated["data"]["ui"] == ui
    assert fake_bus.cleared == [(channel_id, "human", str(human["user"]["id"]))]
    as_agent = test_client.get(f"/api/agentic/mm/channels/{channel_id}/posts", headers=_bearer(agent["api_key"]))
    read = next(p for p in as_agent.json()["posts"] if p["post_id"] == post["post_id"])
    assert read["ui_action"] == post["ui_action"]


def test_a_reusable_surface_takes_many_clicks(test_client, _test_engine, chat, fake_bus):
    human, agent, channel_id = chat
    surface = _choice(test_client, agent, channel_id, once=False)
    fake_bus.published.clear()

    first = _click(test_client, human, surface, key="k1")
    second = _click(test_client, human, surface, bound={"target": ["staging"]}, key="k2")

    assert first.status_code == second.status_code == 200, second.text
    assert [first.json()["message"], second.json()["message"]] == ["Deploy: Production", "Deploy: Staging"]
    ui = _ui_of(_test_engine, surface["post_id"])
    assert (ui["rev"], ui["closed"]) == (0, None)
    assert [kind for kind, _ in _channel_events(fake_bus, channel_id)] == ["post.created", "post.created"]


def test_a_stale_or_closed_surface_is_a_409(test_client, _test_engine, chat):
    human, agent, channel_id = chat
    surface = _choice(test_client, agent, channel_id)

    stale = _click(test_client, human, surface, rev=1)
    assert stale.status_code == 409, stale.text
    assert _click(test_client, human, surface).status_code == 200
    closed = _click(test_client, human, surface, rev=1, key="k2")
    assert closed.status_code == 409, closed.text
    assert len(_posts_in(_test_engine, channel_id)) == 2


def test_only_members_who_may_contact_the_agent_click(test_client, chat):
    human, agent, channel_id = chat
    surface = _choice(test_client, agent, channel_id, once=False)
    outsider = _register_human(test_client, "surface-outsider@test.com")
    member = _member(test_client, human, channel_id, "surface-member@test.com")

    assert _click(test_client, outsider, surface).status_code == 403
    assert _click(test_client, member, surface).status_code == 403
    _grant(test_client, human["access_token"], agent["agent_id"], "human", member["user"]["id"], can_tag=True)
    assert _click(test_client, member, surface).status_code == 200


def test_a_dm_peer_clicks_with_dm_access(test_client):
    owner = _register_human(test_client, "surface-dm-owner@test.com", display_name="Owner")
    peer = _register_human(test_client, "surface-dm-peer@test.com", display_name="Peer")
    agent = _create_agent(test_client, owner_email="surface-dm-owner@test.com")
    org_id = _get_personal_org_id(test_client, owner["access_token"])
    _add_human_to_org(test_client, owner["access_token"], "surface-dm-peer@test.com")
    _grant(test_client, owner["access_token"], agent["agent_id"], "human", peer["user"]["id"], can_dm=True)
    dm_id = _open_dm(test_client, peer["access_token"], org_id, agent["agent_id"], "agent")["channel_id"]

    assert _click(test_client, peer, _choice(test_client, agent, dm_id)).status_code == 200


def test_a_post_without_a_surface_is_a_404(test_client, chat):
    human, agent, channel_id = chat
    plain = _send(test_client, agent, channel_id, {"message": "plain"}).json()

    assert _click(test_client, human, plain).status_code == 404
    assert _click(test_client, human, {"post_id": 9_999_999}).status_code == 404


@pytest.mark.parametrize("source", ["ask", "pick", "docs", "nope"])
def test_the_source_is_an_event_button(test_client, _test_engine, chat, source):
    human, agent, channel_id = chat
    surface = _choice(test_client, agent, channel_id)

    r = _click(test_client, human, surface, source=source)

    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "sourceComponentId names a Button with an event action."
    assert len(_posts_in(_test_engine, channel_id)) == 1


@pytest.mark.parametrize(
    ("bound", "detail"),
    [
        ({"target": ["production"], "build": 1}, "bound holds exactly"),
        ({"target": ["qa"]}, "target holds option values"),
        ({"target": ["staging", "production"]}, "target holds option values"),
    ],
    ids=["a forged literal", "outside the options", "two on a mutually exclusive picker"],
)
def test_bound_values_are_the_pickers_options(test_client, _test_engine, chat, bound, detail):
    human, agent, channel_id = chat
    surface = _choice(test_client, agent, channel_id)

    r = _click(test_client, human, surface, bound=bound)

    assert r.status_code == 422, r.text
    assert r.json()["detail"].startswith(detail)
    assert _ui_of(_test_engine, surface["post_id"])["closed"] is None
    assert len(_posts_in(_test_engine, channel_id)) == 1


def test_a_replayed_click_returns_its_post(test_client, _test_engine, chat, fake_bus):
    human, agent, channel_id = chat
    surface = _choice(test_client, agent, channel_id)
    first = _click(test_client, human, surface).json()
    fake_bus.published.clear()
    fake_bus.cleared.clear()

    again = _click(test_client, human, surface)

    assert again.status_code == 200, again.text
    assert again.json() == first
    assert (fake_bus.published, fake_bus.cleared) == ([], [])
    assert len(_posts_in(_test_engine, channel_id)) == 2
    assert _ui_of(_test_engine, surface["post_id"])["rev"] == 1


def test_client_keys_are_per_human(test_client, _test_engine, chat):
    human, agent, channel_id = chat
    member = _member(test_client, human, channel_id, "surface-keys@test.com")
    _grant(test_client, human["access_token"], agent["agent_id"], "human", member["user"]["id"], can_tag=True)
    surface = _choice(test_client, agent, channel_id, once=False)

    mine = _click(test_client, human, surface).json()
    theirs = _click(test_client, member, surface).json()

    assert mine["post_id"] != theirs["post_id"]
    keys = {row.post_id: row.client_key for row in _posts_in(_test_engine, channel_id)}
    assert (keys[mine["post_id"]], keys[theirs["post_id"]]) == (
        f"h{human['user']['id']}:k1", f"h{member['user']['id']}:k1"
    )


def test_an_action_post_refuses_edits(test_client, _test_engine, chat):
    human, agent, channel_id = chat
    post = _click(test_client, human, _choice(test_client, agent, channel_id)).json()

    r = test_client.patch(
        f"/api/human/mm/posts/{post['post_id']}", json={"message": "edited"}, headers=_bearer(human["access_token"])
    )

    assert r.status_code == 400, r.text
    assert next(row for row in _posts_in(_test_engine, channel_id) if row.post_id == post["post_id"]).message == (
        "Deploy: Production"
    )


def test_an_action_post_notifies_like_a_message(test_client, chat, fake_bus, monkeypatch):
    from clawbits.realtime import web_push

    async def offline(human_ids: list[int]) -> dict[int, str]:
        return dict.fromkeys(human_ids, "offline")

    monkeypatch.setattr(fake_bus, "user_presence_get_many", offline, raising=False)
    human, agent, channel_id = chat
    member = _member(test_client, human, channel_id, "surface-notify@test.com")
    surface = _choice(test_client, agent, channel_id)
    for reader in (human, member):
        test_client.post(
            f"/api/human/mm/channels/{channel_id}/read",
            json={"post_id": surface["post_id"]},
            headers=_bearer(reader["access_token"]),
        )
    pushes: list[tuple[str, int, list[int]]] = []
    monkeypatch.setattr(
        web_push, "schedule_post_web_push", lambda channel, post, ids: pushes.append((channel, post["post_id"], ids))
    )
    fake_bus.published.clear()

    post = _click(test_client, human, surface).json()

    assert _channel_row(test_client, member["access_token"], channel_id)["unread_count"] == 1
    assert _channel_row(test_client, human["access_token"], channel_id)["unread_count"] == 0
    assert pushes == [(channel_id, post["post_id"], [human["user"]["id"], member["user"]["id"]])]
    assert ("post.created", post["post_id"]) in [
        (e["type"], e["data"].get("post_id")) for topic, e in fake_bus.published if topic == human_topic(member["user"]["id"])
    ]


FORM = [
    {"id": "root", "component": "Column", "children": ["ask", "name", "updates", "when", "book"]},
    {"id": "ask", "component": "Text", "text": "Book a demo"},
    {
        "id": "name",
        "component": "TextField",
        "label": "Name",
        "value": {"@path": "/form/name"},
        "checks": [{"condition": {"@call": "required", "args": {"value": {"@path": "/form/name"}}}}],
    },
    {"id": "updates", "component": "CheckBox", "label": "Send me updates", "value": {"@path": "/form/updates"}},
    {
        "id": "when",
        "component": "DateTimeInput",
        "label": "When",
        "enableDate": True,
        "enableTime": True,
        "value": {"@path": "/form/when"},
    },
    {
        "id": "book",
        "component": "Button",
        "child": "book_label",
        "action": {
            "event": {
                "name": "book",
                "context": {
                    "name": {"@path": "/form/name"},
                    "updates": {"@path": "/form/updates"},
                    "when": {"@path": "/form/when"},
                    "source": "chat",
                },
            }
        },
    },
    {"id": "book_label", "component": "Text", "text": "Book"},
]
FORM_MODEL = {"form": {"name": "", "updates": False, "when": ""}}
BOOKING = {"name": "Ada", "updates": True, "when": "2026-11-05T09:30+01:00"}


def _form(tc: TestClient, agent: dict, channel_id: str) -> dict:
    r = _send(tc, agent, channel_id, {"surface": {"components": FORM, "dataModel": FORM_MODEL}})
    assert r.status_code == 200, r.text
    return r.json()


def test_a_form_posts_its_values_and_the_closed_card_keeps_them(test_client, _test_engine, chat, fake_bus):
    human, agent, channel_id = chat
    surface = _form(test_client, agent, channel_id)
    fake_bus.published.clear()

    r = _click(test_client, human, surface, source="book", bound=BOOKING)

    assert r.status_code == 200, r.text
    post = r.json()
    assert post["message"] == "Book\nName: Ada\nSend me updates: yes\nWhen: 2026-11-05 09:30"
    assert post["ui_action"]["context"] == BOOKING | {"source": "chat"}
    ui = _ui_of(_test_engine, surface["post_id"])
    assert (ui["rev"], ui["closed"]["text"]) == (1, "Book")
    assert ui["a2ui"]["createSurface"]["dataModel"] == {"form": BOOKING}
    assert ui["a2ui"]["createSurface"]["components"] == FORM
    updated = next(e for _, e in fake_bus.published if e["type"] == "post.updated")
    assert updated["data"]["ui"] == ui


@pytest.mark.parametrize(
    ("bound", "detail"),
    [
        (BOOKING | {"name": "  "}, "Required."),
        (BOOKING | {"name": None}, "Required."),
        (BOOKING | {"updates": "yes"}, "updates holds true or false for the CheckBox at /form/updates."),
        (BOOKING | {"when": "tomorrow"}, 'when holds "" or ISO 8601 of the parts the DateTimeInput at /form/when enables.'),
        (BOOKING | {"name": "Ada\nLovelace"}, "name holds text of at most 2000 characters"),
    ],
    ids=["a blank required field", "a missing required field", "a checkbox", "a date-time", "a line break"],
)
def test_a_forged_form_click_is_a_422(test_client, _test_engine, chat, bound, detail):
    human, agent, channel_id = chat
    surface = _form(test_client, agent, channel_id)

    r = _click(test_client, human, surface, source="book", bound=bound)

    assert r.status_code == 422, r.text
    assert r.json()["detail"].startswith(detail)
    ui = _ui_of(_test_engine, surface["post_id"])
    assert (ui["rev"], ui["closed"], ui["a2ui"]["createSurface"]["dataModel"]) == (0, None, FORM_MODEL)
    assert len(_posts_in(_test_engine, channel_id)) == 1


def test_an_unchecked_form_is_refused_at_creation(test_client, _test_engine, chat):
    _, agent, channel_id = chat
    secret = [*FORM[:2], FORM[2] | {"variant": "obscured"}, *FORM[3:]]
    undated = [*FORM[:4], {k: v for k, v in FORM[4].items() if k not in ("enableDate", "enableTime")}, *FORM[5:]]

    for components, path in [(secret, "/components/2/variant"), (undated, "/components/4")]:
        r = _send(test_client, agent, channel_id, {"surface": {"components": components, "dataModel": FORM_MODEL}})
        assert r.status_code == 422, r.text
        assert [e["error"]["path"] for e in r.json()["detail"]] == [path]
    tagging = _send(
        test_client, agent, channel_id, {"surface": {"components": FORM, "dataModel": {"form": {"name": "@everyone"}}}}
    )
    assert [e["error"]["path"] for e in tagging.json()["detail"]] == ["/dataModel/form/name"]
    assert _posts_in(_test_engine, channel_id) == []
