"""Tests for the operator/org model: GET /api/agentic/agents/{id}/info,
signup approval bindings, and operator-gated authority."""
import asyncio
import queue
import time

from starlette.testclient import TestClient

from tests.fastapi._auth_helpers import (
    auth_headers,
    login_human,
    register_human,
    signup_agent_via_email,
)
from tests.fastapi.approve_helper import _approve_signup
from tests.fastapi.conftest import _create_agent


def _unique_email(prefix: str) -> str:
    import time
    return f"{prefix}-{int(time.time() * 1000)}@test.com"


def _get_info(test_client: TestClient, agent_id: str, api_key: str) -> dict:
    resp = test_client.get(
        f"/api/agentic/agents/{agent_id}/info",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_info_returns_org_and_operator(test_client):
    """After signup approval, /info reports the agent's bound org and operator."""
    data = _create_agent(test_client)
    info = _get_info(test_client, data["agent_id"], data["api_key"])

    assert info["agent_id"] == data["agent_id"]
    assert info["org_id"] is not None
    assert info["operator_id"] is not None
    assert info["operator_email"] == "stan@clawbits.ai"
    assert info["inter_agent_mode_enabled"] is False
    assert info["snoozed"] is False
    assert info["inter_agent_message_limit"] == 10


def test_info_requires_auth(test_client):
    """Unauthenticated /info fails."""
    resp = test_client.get("/api/agentic/agents/SomeAgent/info")
    assert resp.status_code == 401


def test_only_operator_can_change_settings(test_client):
    """A non-operator org member cannot change an agent's settings."""
    other_email = _unique_email("non-op")
    register_human(test_client, other_email)

    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    info = _get_info(test_client, agent_id, data["api_key"])
    org_id = info["org_id"]

    # Add the other human to the agent's org so org membership is satisfied
    # but they're still not the operator.
    operator_token, _ = login_human(test_client, "stan@clawbits.ai")
    add_resp = test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": other_email, "role": "member"},
        headers=auth_headers(operator_token),
    )
    assert add_resp.status_code == 200, add_resp.text

    other_token, _ = login_human(test_client, other_email)
    resp = test_client.patch(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/settings",
        json={"snoozed": True},
        headers=auth_headers(other_token),
    )
    assert resp.status_code == 403


def test_agent_events_websocket_sends_snapshot(test_client):
    """Agent websocket authenticates by API key and sends the initial control snapshot."""
    data = _create_agent(test_client)
    with test_client.websocket_connect(
        f"/api/agentic/mm/events/ws?api_key={data['api_key']}"
    ) as websocket:
        snapshot = websocket.receive_json()
        websocket.close()
    assert snapshot["type"] == "snapshot"
    assert snapshot["data"]["snoozed"] is False
    assert snapshot["data"]["inter_agent_mode_enabled"] is False
    assert snapshot["data"]["inter_agent_message_limit"] == 10
    assert "channels" in snapshot["data"]


class _FakeBus:
    def __init__(self) -> None:
        self.queues: dict[str, queue.Queue[dict]] = {}

    def _queue(self, topic: str) -> queue.Queue[dict]:
        if topic not in self.queues:
            self.queues[topic] = queue.Queue()
        return self.queues[topic]

    def publish_now(self, topic: str, event: dict) -> None:
        self._queue(topic).put(event)

    async def subscribe(self, topic: str):
        q = self._queue(topic)
        while True:
            try:
                yield q.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.01)


def test_agent_events_websocket_learns_added_channel_without_reconnect(test_client, monkeypatch):
    """A live agent WS gets channel.added and then post.created for that new channel."""
    import clawbits.realtime as realtime

    fake = _FakeBus()
    monkeypatch.setattr(realtime, "get_bus", lambda: fake)
    data = _create_agent(test_client)
    channel_id = "chan-new"
    channel = {"channel_id": channel_id, "channel_type": "direct", "display_name": "new"}
    post = {"id": "p-new", "channel_id": channel_id, "human_id": 1, "message": "hi"}

    with test_client.websocket_connect(
        f"/api/agentic/mm/events/ws?api_key={data['api_key']}"
    ) as websocket:
        assert websocket.receive_json()["type"] == "snapshot"
        fake.publish_now(
            realtime.agent_topic(data["agent_id"]),
            {"type": "channel.added", "channel_id": channel_id, "data": channel},
        )
        assert websocket.receive_json()["type"] == "channel.added"
        # Let the server-side WS attach its new per-channel pump before the post.
        time.sleep(0.05)
        fake.publish_now(
            realtime.channel_topic(channel_id),
            {"type": "post.created", "channel_id": channel_id, "data": post},
        )
        event = websocket.receive_json()
        websocket.close()

    assert event["type"] == "post.created"
    assert event["channel_id"] == channel_id
    assert event["data"]["id"] == "p-new"


def test_operator_can_change_inter_agent_mode_and_snooze(test_client):
    """Operator can flip inter-agent mode/snooze; /info and channel list reflect it."""
    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    info = _get_info(test_client, agent_id, data["api_key"])
    org_id = info["org_id"]

    operator_token, _ = login_human(test_client, "stan@clawbits.ai")
    resp = test_client.patch(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/settings",
        json={"inter_agent_mode_enabled": True, "snoozed": True, "inter_agent_message_limit": 12},
        headers=auth_headers(operator_token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["inter_agent_mode_enabled"] is True
    assert resp.json()["snoozed"] is True
    assert resp.json()["inter_agent_message_limit"] == 12

    info = _get_info(test_client, agent_id, data["api_key"])
    assert info["inter_agent_mode_enabled"] is True
    assert info["snoozed"] is True
    assert info["inter_agent_message_limit"] == 12

    channels = test_client.get(
        "/api/agentic/mm/channels",
        headers={"Authorization": f"Bearer {data['api_key']}"},
    )
    assert channels.status_code == 200, channels.text
    assert channels.json()["inter_agent_mode_enabled"] is True
    assert channels.json()["snoozed"] is True
    assert channels.json()["inter_agent_message_limit"] == 12

    too_high = test_client.patch(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/settings",
        json={"inter_agent_message_limit": 51},
        headers=auth_headers(operator_token),
    )
    assert too_high.status_code == 422


def test_org_member_can_delete_agent(test_client):
    """Any org member (operator or not) can hard-delete the agent."""
    other_email = _unique_email("deleter")
    register_human(test_client, other_email)

    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    info = _get_info(test_client, agent_id, data["api_key"])
    org_id = info["org_id"]

    operator_token, _ = login_human(test_client, "stan@clawbits.ai")
    add_resp = test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": other_email, "role": "member"},
        headers=auth_headers(operator_token),
    )
    assert add_resp.status_code == 200, add_resp.text

    other_token, _ = login_human(test_client, other_email)
    resp = test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent_id}",
        headers=auth_headers(other_token),
    )
    assert resp.status_code == 200
    assert resp.json()["deleted"] is True


def test_signup_requires_org_id(test_client):
    """POST signup with no org_id 422s."""
    resp = test_client.post("/api/agentic/agents/signup", json={})
    assert resp.status_code == 422


def test_pending_signup_no_operator_until_approval(test_client):
    """An agent in pending_approval has no bound org/operator on /info."""
    from clawbits.datastructures.known_answers import get_answer_for_question

    resp = signup_agent_via_email(test_client, "stan@clawbits.ai")
    assert resp.status_code == 200, resp.text
    challenge = resp.json()
    answer = get_answer_for_question(challenge["challenge"])
    commit = test_client.post(
        "/api/agentic/signup-commit",
        json={
            "session_token": challenge["session_token"],
            "challenge_response": answer,
        },
    )
    assert commit.status_code == 200, commit.text
    data = commit.json()
    assert data["status"] == "pending_approval"

    info = _get_info(test_client, data["agent_id"], data["api_key"])
    assert info["org_id"] is None
    assert info["operator_id"] is None

    # Approve, then info reflects the binding.
    _approve_signup(test_client, data)
    info = _get_info(test_client, data["agent_id"], data["api_key"])
    assert info["org_id"] is not None
    assert info["operator_id"] is not None


def test_delete_agent_nulls_fks_to_mm_posts(test_client):
    """``delete_agent`` must null out every dangling FK before deleting the
    agent's row in channels that SURVIVE the delete (group channels other
    members keep using), or PostgreSQL rejects with a foreign-key violation.
    (DMs are torn down whole instead — see
    ``test_delete_agent_default_tears_down_dm_channels``.)

    Three FKs lack ON DELETE behaviour at the schema level:
      - ``human_channel_state.last_read_post_id`` (operator's read pointer)
      - ``mm_posts.parent_post_id`` (replies anchored on the deleted post)
      - ``mm_channels.last_message_author_agent_id`` (sidebar preview
        attribution when the agent authored the channel's last post)

    A second class of reference lives in ``mm_channel_events`` (the
    member.added / member.removed log), which points at the agent twice —
    ``actor_agent_id`` and ``subject_agent_id``. Those FKs are plain
    NO ACTION too, but the rows are dropped rather than nulled (an
    actor-only row can't be nulled without breaking the actor check, and a
    subject-less membership event is meaningless once the agent is gone).

    This test pre-populates all of the above in a public channel before
    calling ``delete_agent`` and confirms the delete succeeds, the agent is
    gone, the surviving rows have their references nulled, and the event rows
    are removed.
    """
    import uuid

    from sqlmodel import Session, select

    from clawbits.db.models import (
        Agent,
        HumanChannelState,
        MmChannel,
        MmChannelEvent,
        MmPost,
    )
    from clawbits.db.table_write import TableWrite

    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    info = _get_info(test_client, agent_id, data["api_key"])
    operator_id = info["operator_id"]
    org_id = info["org_id"]
    assert operator_id is not None

    server = test_client.app
    with Session(server._engine) as s:
        # A public (group) channel — the kind that outlives the agent because
        # other members keep using it.
        channel_id = str(uuid.uuid4())
        TableWrite.create_mm_channel(
            s,
            channel_id=channel_id,
            name=f"group-{channel_id[:8]}",
            channel_type="public",
            org_id=org_id,
            created_by_agent=agent_id,
        )
        TableWrite.add_mm_channel_member(s, channel_id, agent_id)
        TableWrite.add_mm_channel_member_human(s, channel_id, operator_id)

        agent_post = MmPost(
            channel_id=channel_id,
            agent_id=agent_id,
            message="hello channel",
            status="published",
        )
        s.add(agent_post)
        s.flush()
        agent_post_id = agent_post.post_id

        # Sidebar preview is denormalised onto the channel row. Set it so
        # ``mm_channels.last_message_author_agent_id`` references the
        # agent — covers the third FK case.
        channel = s.get(MmChannel, channel_id)
        channel.last_message_text = agent_post.message
        channel.last_message_author_agent_id = agent_id
        channel.last_message_author_display_name = agent_id
        s.add(channel)
        s.flush()

        # Reply from the operator that anchors on the agent's post — covers
        # the parent_post_id FK case.
        reply = MmPost(
            channel_id=channel_id,
            human_id=operator_id,
            message="thanks",
            status="published",
            parent_post_id=agent_post.post_id,
        )
        s.add(reply)
        s.flush()
        reply_id = reply.post_id

        # Operator marks the agent's post as read — covers the
        # last_read_post_id FK case.
        hcs = HumanChannelState(
            human_id=operator_id,
            channel_id=channel_id,
            last_read_post_id=agent_post.post_id,
        )
        s.add(hcs)

        # Channel-event log rows referencing the agent. Inserted directly to
        # exercise both FKs: as the subject a change was performed on (the
        # exact constraint in the production error) and as the actor who
        # performed one. Each blocks the delete until removed.
        subject_event = MmChannelEvent(
            channel_id=channel_id,
            event_type="member.added",
            actor_human_id=operator_id,
            subject_agent_id=agent_id,
        )
        actor_event = MmChannelEvent(
            channel_id=channel_id,
            event_type="member.removed",
            actor_agent_id=agent_id,
            subject_human_id=operator_id,
        )
        s.add(subject_event)
        s.add(actor_event)
        s.flush()
        subject_event_id = subject_event.event_id
        actor_event_id = actor_event.event_id
        s.commit()

    with Session(server._engine) as s:
        TableWrite.delete_agent(s, agent_id)
        s.commit()

    with Session(server._engine) as s:
        # Agent and its post both gone.
        assert s.get(Agent, agent_id) is None
        assert s.get(MmPost, agent_post_id) is None

        # Reply survives; parent_post_id was nulled so the FK was satisfied.
        surviving_reply = s.get(MmPost, reply_id)
        assert surviving_reply is not None
        assert surviving_reply.parent_post_id is None

        # Read-pointer row survives. It pointed at the agent's post, which was
        # the channel's *first*, so there's nothing earlier to rewind to and
        # the pointer ends up NULL. (When an earlier post does survive the
        # pointer moves back onto it instead — see
        # ``test_delete_agent_rewinds_read_pointer_rather_than_clearing_it``.)
        surviving_hcs = s.exec(
            select(HumanChannelState).where(
                HumanChannelState.human_id == operator_id,
                HumanChannelState.channel_id == channel_id,
            )
        ).first()
        assert surviving_hcs is not None
        assert surviving_hcs.last_read_post_id is None

        # Channel survives (a human remains). The sidebar preview is rebuilt
        # from the surviving operator reply rather than left dangling on the
        # deleted agent post: agent attribution is cleared and the preview now
        # reflects the operator's "thanks".
        surviving_channel = s.get(MmChannel, channel_id)
        assert surviving_channel is not None
        assert surviving_channel.last_message_author_agent_id is None
        assert surviving_channel.last_message_author_human_id == operator_id
        assert surviving_channel.last_message_text == "thanks"

        # Both channel-event rows referencing the agent were removed, so the
        # subject/actor FKs no longer blocked the delete.
        assert s.get(MmChannelEvent, subject_event_id) is None
        assert s.get(MmChannelEvent, actor_event_id) is None


def test_delete_agent_rewinds_read_pointer_rather_than_clearing_it(test_client):
    """A read pointer parked on one of the deleted agent's posts must rewind
    to the newest surviving post before it — not go NULL.

    The unread query reads a NULL pointer as ``coalesce(..., 0)`` — "never
    read anything" — so clearing it re-marks the channel's whole history
    unread for everyone whose last read happened to be the agent's message.
    That's an unread badge in every channel the agent talked in, with nothing
    new in them to explain it.
    """
    import uuid

    from sqlmodel import Session, select

    from clawbits.db.models import HumanChannelState, MmChannel, MmPost
    from clawbits.db.table_write import TableWrite

    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    info = _get_info(test_client, agent_id, data["api_key"])
    operator_id = info["operator_id"]
    org_id = info["org_id"]

    server = test_client.app
    with Session(server._engine) as s:
        channel_id = str(uuid.uuid4())
        TableWrite.create_mm_channel(
            s,
            channel_id=channel_id,
            name=f"group-{channel_id[:8]}",
            channel_type="public",
            org_id=org_id,
        )
        TableWrite.add_mm_channel_member(s, channel_id, agent_id)
        TableWrite.add_mm_channel_member_human(s, channel_id, operator_id)

        human_post = MmPost(
            channel_id=channel_id,
            human_id=operator_id,
            message="human first",
            status="published",
        )
        s.add(human_post)
        s.flush()
        human_post_id = human_post.post_id

        agent_post = MmPost(
            channel_id=channel_id,
            agent_id=agent_id,
            message="agent replies last",
            status="published",
        )
        s.add(agent_post)
        s.flush()

        # Operator has read everything — pointer sits on the agent's message.
        s.add(
            HumanChannelState(
                human_id=operator_id,
                channel_id=channel_id,
                last_read_post_id=agent_post.post_id,
            )
        )
        s.commit()

    with Session(server._engine) as s:
        TableWrite.delete_agent(s, agent_id)
        s.commit()

    with Session(server._engine) as s:
        state = s.exec(
            select(HumanChannelState).where(
                HumanChannelState.human_id == operator_id,
                HumanChannelState.channel_id == channel_id,
            )
        ).first()
        assert state is not None
        # Rewound onto the surviving human post — everything published is
        # still at or before the pointer, so the channel stays read.
        assert state.last_read_post_id == human_post_id
        assert s.get(MmChannel, channel_id) is not None


def test_delete_agent_default_tears_down_dm_channels(test_client):
    """On a full (non-keep) delete, the agent's DM channels are removed whole
    — the entire two-party conversation, not just the agent's messages — so no
    orphaned DM is left behind for the other party."""
    from sqlmodel import Session, select

    from clawbits.db.models import Agent, MmChannel, MmChannelMember, MmPost
    from clawbits.db.table_write import TableWrite

    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    info = _get_info(test_client, agent_id, data["api_key"])
    operator_id = info["operator_id"]

    server = test_client.app
    with Session(server._engine) as s:
        # The operator↔agent DM channel provisioned at signup approval.
        dm = s.exec(
            select(MmChannel)
            .where(MmChannel.channel_type == "direct")
            .where(
                MmChannel.channel_id.in_(
                    select(MmChannelMember.channel_id).where(
                        MmChannelMember.agent_id == agent_id
                    )
                )
            )
        ).first()
        assert dm is not None, "expected the operator DM channel"
        dm_id = dm.channel_id

        # The operator's own message in the DM — must go with the channel.
        op_post = MmPost(
            channel_id=dm_id,
            human_id=operator_id,
            message="hi agent",
            status="published",
        )
        s.add(op_post)
        s.commit()
        op_post_id = op_post.post_id

    with Session(server._engine) as s:
        TableWrite.delete_agent(s, agent_id)
        s.commit()

    with Session(server._engine) as s:
        assert s.get(Agent, agent_id) is None
        # The whole DM is gone: the channel, its membership rows, and even the
        # operator's message in it.
        assert s.get(MmChannel, dm_id) is None
        assert s.get(MmPost, op_post_id) is None
        assert (
            s.exec(
                select(MmChannelMember).where(MmChannelMember.channel_id == dm_id)
            ).first()
            is None
        )


def test_delete_agent_keep_content_reassigns_to_placeholder(test_client):
    """``delete_agent(..., keep_content=True)`` must re-home the agent's
    authored content — channel messages, social posts, files, reactions,
    comments, likes, and the denormalised channel author pointers — to the
    shared ``deleted-agent`` placeholder, then drop the agent itself, so the
    conversation history survives for the other members who shared those
    channels instead of being wiped along with the agent.
    """
    from sqlmodel import Session, select

    from clawbits.db.models import (
        Agent,
        AgentPost,
        MmChannel,
        MmChannelMember,
        MmFile,
        MmPost,
        MmPostReaction,
        PostComment,
        PostLike,
    )
    from clawbits.db.table_write import DELETED_AGENT_ID, TableWrite

    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    info = _get_info(test_client, agent_id, data["api_key"])
    operator_id = info["operator_id"]
    assert operator_id is not None

    server = test_client.app
    with Session(server._engine) as s:
        channel = s.exec(
            select(MmChannel).where(MmChannel.created_by_agent == agent_id)
        ).first()
        assert channel is not None, "expected the operator DM channel"
        channel_id = channel.channel_id

        # Channel message authored by the agent + a reaction by the agent.
        agent_post = MmPost(
            channel_id=channel_id,
            agent_id=agent_id,
            message="hello operator",
            status="published",
        )
        s.add(agent_post)
        s.flush()
        agent_post_id = agent_post.post_id

        reaction = MmPostReaction(
            post_id=agent_post.post_id, emoji="👍", agent_id=agent_id
        )
        s.add(reaction)
        s.flush()
        reaction_id = reaction.id

        # File uploaded by the agent.
        agent_file = MmFile(
            file_id="file-keep-1",
            channel_id=channel_id,
            uploader_agent_id=agent_id,
            object_key="k/keep-1",
            filename="keep.txt",
            content_type="text/plain",
            size_bytes=4,
            status="uploaded",
        )
        s.add(agent_file)

        # Social post by the agent, with the agent's own comment + like.
        social = AgentPost(agent_id=agent_id, message_type="say", message="gm")
        s.add(social)
        s.flush()
        social_id = social.post_id
        s.add(PostComment(post_id=social.post_id, agent_id=agent_id, message="nice"))
        s.add(PostLike(post_id=social.post_id, agent_id=agent_id))

        # Denormalised sidebar preview points at the agent.
        channel.last_message_text = agent_post.message
        channel.last_message_author_agent_id = agent_id
        channel.last_message_author_display_name = agent_id
        s.add(channel)
        s.commit()

    with Session(server._engine) as s:
        TableWrite.delete_agent(s, agent_id, keep_content=True)
        s.commit()

    with Session(server._engine) as s:
        # The agent is gone; the placeholder exists and belongs to no org, so
        # it never surfaces in any org's agent list.
        assert s.get(Agent, agent_id) is None
        tomb = s.get(Agent, DELETED_AGENT_ID)
        assert tomb is not None
        assert tomb.org_id is None
        assert tomb.nickname == "Deleted agent"

        # Every authored row survives, reattributed to the placeholder.
        kept_post = s.get(MmPost, agent_post_id)
        assert kept_post is not None
        assert kept_post.agent_id == DELETED_AGENT_ID

        kept_reaction = s.get(MmPostReaction, reaction_id)
        assert kept_reaction is not None
        assert kept_reaction.agent_id == DELETED_AGENT_ID

        kept_file = s.get(MmFile, "file-keep-1")
        assert kept_file is not None
        assert kept_file.uploader_agent_id == DELETED_AGENT_ID

        kept_social = s.get(AgentPost, social_id)
        assert kept_social is not None
        assert kept_social.agent_id == DELETED_AGENT_ID

        kept_comment = s.exec(
            select(PostComment).where(PostComment.post_id == social_id)
        ).first()
        assert kept_comment is not None
        assert kept_comment.agent_id == DELETED_AGENT_ID

        kept_like = s.exec(
            select(PostLike).where(PostLike.post_id == social_id)
        ).first()
        assert kept_like is not None
        assert kept_like.agent_id == DELETED_AGENT_ID

        # Channel author pointers re-homed to the placeholder; the cached
        # preview author name now reads "Deleted agent".
        kept_channel = s.get(MmChannel, channel_id)
        assert kept_channel is not None
        assert kept_channel.created_by_agent == DELETED_AGENT_ID
        assert kept_channel.last_message_author_agent_id == DELETED_AGENT_ID
        assert kept_channel.last_message_author_display_name == "Deleted agent"

        # The DM chat is preserved: the agent's membership in the direct
        # channel was re-pointed to the placeholder (so it still renders as a
        # DM with "Deleted agent"), and the deleted agent holds no membership
        # rows anywhere.
        assert kept_channel.channel_type == "direct"
        dm_membership = s.exec(
            select(MmChannelMember).where(
                MmChannelMember.channel_id == channel_id,
                MmChannelMember.agent_id == DELETED_AGENT_ID,
            )
        ).first()
        assert dm_membership is not None
        assert (
            s.exec(
                select(MmChannelMember).where(MmChannelMember.agent_id == agent_id)
            ).first()
            is None
        )


def test_delete_agent_endpoint_keep_content_query_param(test_client):
    """DELETE ...?keep_content=true removes the agent over HTTP but reassigns
    its messages to the placeholder rather than deleting them."""
    from sqlmodel import Session, select

    from clawbits.db.models import Agent, MmChannel, MmPost
    from clawbits.db.table_write import DELETED_AGENT_ID

    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    info = _get_info(test_client, agent_id, data["api_key"])
    org_id = info["org_id"]

    server = test_client.app
    with Session(server._engine) as s:
        channel = s.exec(
            select(MmChannel).where(MmChannel.created_by_agent == agent_id)
        ).first()
        assert channel is not None
        post = MmPost(
            channel_id=channel.channel_id,
            agent_id=agent_id,
            message="keep me",
            status="published",
        )
        s.add(post)
        s.commit()
        post_id = post.post_id

    operator_token, _ = login_human(test_client, "stan@clawbits.ai")
    resp = test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent_id}?keep_content=true",
        headers=auth_headers(operator_token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["deleted"] is True

    with Session(server._engine) as s:
        assert s.get(Agent, agent_id) is None
        kept = s.get(MmPost, post_id)
        assert kept is not None
        assert kept.agent_id == DELETED_AGENT_ID


def test_ensure_owner_agent_comm_channel_reuses_canonical_name_squatter(test_client):
    """When a channel already exists under the canonical operator-DM name
    in the agent's org but has lost its membership rows (orphan from a
    previous partially-committed approval, or an ``agent_id`` re-used
    after deletion), ``ensure_owner_agent_comm_channel`` must reuse the
    existing channel and reconcile membership — not blow up on the
    ``uq_mm_channels_org_name`` unique constraint with a fresh INSERT.

    Reproduces the production IntegrityError on
    ``Key (org_id, name)=(<org>, dm-human-<id>-agent-<id>) already exists``.
    """
    from sqlmodel import Session, delete, select

    from clawbits.db.models import MmChannel, MmChannelMember
    from clawbits.db.table_read import TableRead
    from clawbits.db.table_write import TableWrite

    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    info = _get_info(test_client, agent_id, data["api_key"])
    operator_id = info["operator_id"]
    org_id = info["org_id"]
    assert operator_id is not None and org_id is not None

    canonical_name = f"dm-human-{operator_id}-agent-{agent_id}"
    server = test_client.app

    # The normal flow already created the operator DM with both members.
    # Strip the membership rows so the fast resolver
    # ``find_dm_channel_human_agent`` can't find the channel — the row
    # under the canonical name remains, mimicking the orphan-channel
    # production case.
    with Session(server._engine) as s:
        orphan = s.exec(
            select(MmChannel)
            .where(MmChannel.org_id == org_id)
            .where(MmChannel.name == canonical_name)
        ).first()
        assert orphan is not None, "expected the operator DM created at approval"
        orphan_channel_id = orphan.channel_id
        s.exec(
            delete(MmChannelMember).where(
                MmChannelMember.channel_id == orphan_channel_id
            )
        )
        s.commit()

    # Sanity: the fast resolver no longer finds it (no members), but the
    # canonical name is still occupied — exactly the production shape.
    with Session(server._engine) as s:
        assert (
            TableRead.find_dm_channel_human_agent(
                s, int(operator_id), agent_id, org_id
            )
            is None
        )
        assert (
            TableRead.get_mm_channel_by_org_and_name(s, org_id, canonical_name)
            is not None
        )

    # The function must reuse the existing channel (not 409 on the
    # unique-name constraint) and add the membership rows back.
    with Session(server._engine) as s:
        channel, created = TableWrite.ensure_owner_agent_comm_channel(s, agent_id)
        s.commit()
        assert channel is not None
        assert created is False, "should reuse the existing canonical-name channel"
        assert channel["channel_id"] == orphan_channel_id
        assert channel["name"] == canonical_name

    # Memberships reconciled, fast resolver finds it again.
    with Session(server._engine) as s:
        assert TableRead.is_mm_channel_member(s, orphan_channel_id, agent_id)
        assert TableRead.is_mm_channel_member_human(
            s, orphan_channel_id, int(operator_id)
        )
        found = TableRead.find_dm_channel_human_agent(
            s, int(operator_id), agent_id, org_id
        )
        assert found is not None and found["channel_id"] == orphan_channel_id


# ---------------------------------------------------------------------------
# Tests: rename (PATCH /api/human/orgs/{org_id}/agents/{agent_id}/name)
# ---------------------------------------------------------------------------

def test_operator_can_rename_agent(test_client):
    """Operator renames; response and the org agents list reflect it."""
    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    org_id = _get_info(test_client, agent_id, data["api_key"])["org_id"]

    token, _ = login_human(test_client, "stan@clawbits.ai")
    resp = test_client.patch(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/name",
        json={"nickname": "  Crabby  "},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"agent_id": agent_id, "nickname": "Crabby"}

    agents = test_client.get(
        f"/api/human/orgs/{org_id}/agents", headers=auth_headers(token)
    ).json()["agents"]
    me = next(a for a in agents if a["agent_id"] == agent_id)
    assert me["nickname"] == "Crabby"


def test_non_operator_cannot_rename_agent(test_client):
    """An org member who is not the operator gets 403 — even as org owner."""
    other_email = _unique_email("renamer")
    register_human(test_client, other_email)

    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    org_id = _get_info(test_client, agent_id, data["api_key"])["org_id"]

    operator_token, _ = login_human(test_client, "stan@clawbits.ai")
    add_resp = test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": other_email, "role": "owner"},
        headers=auth_headers(operator_token),
    )
    assert add_resp.status_code == 200, add_resp.text

    other_token, _ = login_human(test_client, other_email)
    resp = test_client.patch(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/name",
        json={"nickname": "Hijacked"},
        headers=auth_headers(other_token),
    )
    assert resp.status_code == 403


def test_rename_agent_validation(test_client):
    """Empty, whitespace-only, and over-long names are rejected."""
    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    org_id = _get_info(test_client, agent_id, data["api_key"])["org_id"]
    token, _ = login_human(test_client, "stan@clawbits.ai")

    def _rename(name):
        return test_client.patch(
            f"/api/human/orgs/{org_id}/agents/{agent_id}/name",
            json={"nickname": name},
            headers=auth_headers(token),
        )

    assert _rename("").status_code == 422
    assert _rename("   ").status_code == 400
    assert _rename("x" * 33).status_code == 422
    # Boundary: exactly 32 chars is fine.
    assert _rename("x" * 32).status_code == 200
