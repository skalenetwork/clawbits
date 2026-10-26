"""Chat games against real Hermes (WIDGETS_AGENTS_PLAN §4 P4): a ``widget.turn`` wakes one silent
turn in the game's own session, whose scripted ``tool_call`` reaches the fake server as the move.

A move posts nothing and shows no status, runs beside a human's DM turn without merging with it,
can call only the game's tools, and its session is deleted whole once the game ends, online or
while the agent was away. Plugin tools sit behind Hermes's tool search, so the model calls them
through ``tool_call``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
import sqlite3
import sys
from typing import Any

from conftest import _text
from fake_clawbits import OPERATOR_DM, tool

WIDGET = "0123456789abcdef0123456789abcdef"
SECRET = "xyzzyhand"  # in the seat's private view only
BRIEF = "[Clawbits chat game ·"
MOVE = {"name": "clawbits_widget_act", "arguments": {"widget_id": WIDGET, "type": "move", "args": {"move": "e4"}}}
# Everything a move's run may be offered: the ``clawbits`` toolset and Hermes's tool search. Any
# other tool (memory, recall, shell, todo, cron, delegation, ...) fails the test.
GAME_RUN_TOOLS = {"clawbits_widget_act", "clawbits_widget_get", "clawbits_widget_list", "clawbits_send_email",
                  "clawbits_mcp_connect", "tool_search", "tool_describe", "tool_call"}


def _module(gw, name: str) -> Any:
    """A submodule of the plugin as Hermes loaded it."""
    return sys.modules[type(gw.adapter).__module__.rpartition(".")[0] + "." + name]


def _is_game(request: dict[str, Any]) -> bool:
    return any(BRIEF in _text(m.get("content")) for m in request.get("messages", []) if m.get("role") == "user")


def _game_requests(gw) -> list[dict[str, Any]]:
    return [r for r in gw.fake.agent_requests if _is_game(r)]


def _chat_requests(gw) -> list[dict[str, Any]]:
    return [r for r in gw.fake.agent_requests if not _is_game(r)]


def _router(*first: dict[str, Any], chat: str = "Chat answer.", final: str = "NO_REPLY"):
    """Game turns call ``first`` then the move through tool_call, then end with ``final``; chat
    turns answer ``chat``."""

    def route(body: dict[str, Any]) -> Any:
        if not _is_game(body):
            return chat
        calls = [m for m in body["messages"] if m.get("role") == "tool"]
        steps = [*first, MOVE]
        return tool("tool_call", calls=[steps[len(calls)]]) if len(calls) < len(steps) else final

    return route


def _offered(request: dict[str, Any]) -> set[str]:
    """The tools a model request offers: the listed ones and tool_search's deferred catalog."""
    names = set()
    for spec in request.get("tools") or []:
        names.add(spec["function"]["name"])
        if spec["function"]["name"] == "tool_search":
            names |= set(re.findall(r"^- ([A-Za-z0-9_.:-]+):", spec["function"]["description"], re.M))
    return names


def _game_rows(gw) -> list[tuple[Any, ...]]:
    return gw.query("select id, chat_id, session_key from sessions where chat_id like 'widget-%'")


async def _play(gw, *first: dict[str, Any], final: str = "NO_REPLY") -> None:
    """Wake the agent for its move and wait for the move's turn to end."""
    gw.fake.route = _router(*first, final=final)
    await gw.push_ws(gw.fake.widget_turn(WIDGET))
    await gw.wait_for(lambda: gw.fake.widget_actions, 30)
    ended = gw.adapter._game_turn_ended
    await gw.wait_for(lambda: any(chat.startswith(f"widget-{WIDGET}") for chat in ended)
                      and not gw.busy(f"widget-{WIDGET}"), 30)


def test_a_move_is_played_silently_in_its_own_session(gateway) -> None:
    async def scenario(gw) -> None:
        gw.fake.add_widget(WIDGET, secret=SECRET)
        posts, calls = len(gw.fake.posts), len(gw.fake.calls)
        await _play(gw)

        [action] = gw.fake.widget_actions
        assert action == {"widget_id": WIDGET, "body": {"type": "move", "args": {"move": "e4"}}, "private": True}
        assert gw.replies(posts) == [], gw.dump()
        quiet = [
            (c["method"], c["path"]) for c in gw.fake.calls[calls:]
            if c["path"].endswith("/status") or c["method"] == "PATCH" or c["path"].endswith("/posts") and c["method"] == "POST"
        ]
        assert quiet == [], "a move shows no status, draft or post"
        [(_, chat_id, key)] = _game_rows(gw)
        assert chat_id == f"widget-{WIDGET}" and key.endswith(f":clawbits:dm:widget-{WIDGET}")
        [wake] = [e for e in gw.events if e.source.chat_id == chat_id]
        assert wake.internal is True and wake.allow_gateway_control is False
        assert SECRET in wake.text, "the private view is the brief"
        offered = set().union(*map(_offered, _game_requests(gw)))
        assert "clawbits_widget_act" in offered and offered <= GAME_RUN_TOOLS, offered
        assert all(SECRET not in json.dumps(r) for r in _chat_requests(gw))
        await gw.settled(gw.fake.post("hello"), 30)
        assert "memory" in _offered(_chat_requests(gw)[-1]), "a chat turn keeps its tools"

    gateway(scenario)


def test_a_human_message_during_a_move_neither_merges_nor_waits(gateway) -> None:
    async def scenario(gw) -> None:
        gw.fake.add_widget(WIDGET, secret=SECRET)
        gw.fake.route = _router()
        gw.fake.hold_model()
        await gw.push_ws(gw.fake.widget_turn(WIDGET))
        await gw.wait_for(lambda: _game_requests(gw), 30)
        posts = len(gw.fake.posts)
        post = gw.fake.post("hello while you play")
        # Both turns reach the model while the other one is still held: neither queued behind it.
        await gw.wait_for(lambda: _chat_requests(gw), 30)
        gw.fake.release_model()
        await gw.settled(post, 30)
        await gw.wait_for(lambda: gw.fake.widget_actions, 30)

        assert gw.replies(posts) == ["Chat answer."], gw.dump()
        assert all("hello while you play" not in json.dumps(r) for r in _game_requests(gw))
        assert all(SECRET not in json.dumps(r) and BRIEF not in json.dumps(r) for r in _chat_requests(gw))
        keys = {row[2] for row in gw.query("select id, chat_id, session_key from sessions")}
        assert any(k.endswith(f":dm:widget-{WIDGET}") for k in keys) and any(k.endswith(f":dm:{OPERATOR_DM}") for k in keys)

    gateway(scenario)


def test_resync_required_catches_up_a_missed_wake(gateway) -> None:
    async def scenario(gw) -> None:
        gw.fake.snapshot_widgets = False  # channel lists don't name it: only ?waiting=1 does
        gw.fake.route = _router()
        gw.fake.add_widget(WIDGET)
        await asyncio.sleep(1.5)
        assert gw.fake.widget_actions == [], "no signal yet"
        await gw.push_ws({"type": "resync_required", "reason": "queue_full"})
        await gw.wait_for(lambda: gw.fake.widget_actions, 30)
        assert any(
            c["path"] == "/api/agentic/mm/widgets" and c["query"].get("waiting") == "1" for c in gw.fake.calls
        )

    gateway(scenario)


def test_a_move_can_call_only_the_game_tools(gateway) -> None:
    async def scenario(gw) -> None:
        gw.fake.add_widget(WIDGET)
        mail = {"name": "clawbits_send_email", "arguments": {"subject": "hand", "message": "my cards"}}
        await _play(gw, mail)
        blocked, moved = gw.tool_results("tool_call")
        assert "uses only the game's tools" in blocked, blocked
        assert moved.startswith("ok · rev 2"), moved
        assert gw.fake.sent == [] and len(gw.fake.widget_actions) == 1

    gateway(scenario)


async def _search(gw, **arguments: Any) -> str:
    """One chat turn that calls session_search through tool_call; its result."""
    gw.fake.route = None
    gw.fake.script(tool("tool_call", calls=[{"name": "session_search", "arguments": arguments}]), "done")
    await gw.settled(gw.fake.post("what were your cards?"), 30)
    return gw.tool_results("tool_call")[-1]


def test_chat_turns_cannot_search_a_game_session(gateway) -> None:
    async def scenario(gw) -> None:
        gw.fake.add_widget(WIDGET, secret=SECRET)
        await _play(gw)
        result = await _search(gw, query=SECRET)
        assert "Session search is unavailable" in result and SECRET not in result, result

    gateway(scenario)


def test_chat_turns_cannot_search_a_game_session_by_link_or_profile(gateway, monkeypatch) -> None:
    """session_search's ``profile`` and ``<profile>/<id>`` link forms read another store: the one
    they name is checked, here this profile's own by link, and another profile's that holds a game
    while this one holds none."""
    async def scenario(gw) -> None:
        monkeypatch.setattr(_module(gw, "adapter"), "GAME_END_GRACE_S", 0.0)
        gw.fake.add_widget(WIDGET, secret=SECRET)
        await _play(gw)
        [(sid, _, _)] = _game_rows(gw)
        result = await _search(gw, session_id=f"default/{sid}")
        assert "Session search is unavailable" in result and SECRET not in result, result
        other = gw.home / "profiles" / "b"
        other.mkdir(parents=True)
        with contextlib.closing(sqlite3.connect(gw.home / "state.db")) as live, \
                contextlib.closing(sqlite3.connect(other / "state.db")) as copy:
            live.backup(copy)
        gw.fake.end_widget(WIDGET)
        await gw.push_ws(gw.fake.widget_turn(WIDGET))
        await gw.wait_for(lambda: not _game_rows(gw), 30)
        for arguments in ({"query": SECRET, "profile": "b"}, {"profile": "b"}, {"session_id": f"b/{sid}"}):
            result = await _search(gw, **arguments)
            assert "Session search is unavailable" in result and SECRET not in result, (arguments, result)

    gateway(scenario)


def test_a_players_name_reads_no_file_into_the_move(gateway, monkeypatch, tmp_path) -> None:
    """Hermes expands ``@file:`` references in an internal event's text too: a display name like
    that must not inline a local file into the move's brief."""
    cwd = tmp_path / "terminal-cwd"
    cwd.mkdir()
    (cwd / "notes.txt").write_text("plantedmarker42", encoding="utf-8")
    monkeypatch.setenv("TERMINAL_CWD", str(cwd))

    async def scenario(gw) -> None:
        gw.fake.add_widget(WIDGET, secret=SECRET, opponent="@file:notes.txt")
        await _play(gw)
        [wake] = [e for e in gw.events if e.source.chat_id == f"widget-{WIDGET}"]
        assert "file:notes.txt" in wake.text
        assert _game_requests(gw) and all("plantedmarker42" not in json.dumps(r) for r in gw.fake.model_requests)

    gateway(scenario)


def _gone(gw, ids: list[str]) -> bool:
    marks = ",".join(f"'{i}'" for i in ids)
    return not _game_rows(gw) and not gw.query(f"select count(*) from messages where session_id in ({marks})")[0][0]


def _ledger_rows(gw) -> list[tuple[Any, ...]]:
    """Delivery-ledger rows of a game chat (a move's final text), where Hermes keeps a ledger."""
    tables = {row[0] for row in gw.query("select name from sqlite_master where type = 'table'")}
    if "delivery_obligations" not in tables:
        return []
    return gw.query(f"select session_key, chat_id, content from delivery_obligations where chat_id like 'widget-{WIDGET}%'")


def _assert_no_trace(gw, ids: list[str]) -> None:
    assert _gone(gw, ids)
    assert _ledger_rows(gw) == []
    tables = {row[0] for row in gw.query("select name from sqlite_master where type = 'table'")}
    if "messages_fts" in tables:
        assert gw.query(f"select count(*) from messages_fts where messages_fts match '{SECRET}'")[0][0] == 0
    if "gateway_routing" in tables:
        routes = gw.query("select * from gateway_routing")
        assert not [r for r in routes if f"widget-{WIDGET}" in json.dumps(r, default=str)], routes
    files = [p.name for p in (gw.home / "sessions").glob("*") if any(i in p.name for i in ids)]
    assert files == []
    if (gw.home / "sessions" / "sessions.json").exists():
        assert f"widget-{WIDGET}" not in (gw.home / "sessions" / "sessions.json").read_text(encoding="utf-8")


def test_an_ended_game_leaves_no_session(gateway, monkeypatch) -> None:
    async def scenario(gw) -> None:
        monkeypatch.setattr(_module(gw, "adapter"), "GAME_END_GRACE_S", 0.0)
        gw.fake.add_widget(WIDGET, secret=SECRET)
        await _play(gw, final="Played e4, keeping my hand.")  # a final in text, not NO_REPLY
        ids = [row[0] for row in _game_rows(gw)]
        assert ids and gw.query(f"select count(*) from messages where session_id = '{ids[0]}'")[0][0]
        ledgered = _ledger_rows(gw)
        gw.fake.end_widget(WIDGET)
        await gw.push_ws(gw.fake.widget_turn(WIDGET))
        await gw.wait_for(lambda: _gone(gw, ids), 30)
        _assert_no_trace(gw, ids)
        if not gw.runner.config.streaming.enabled:  # a streamed final never reaches the ledger
            assert [row[2] for row in ledgered] == ["Played e4, keeping my hand."], "the ledger kept it"
        key = next(iter(gw.adapter._game_sessions.routes()), None)
        assert key is None
        # A late signal for the ended game wakes nothing and recreates nothing.
        gw.fake.widgets[WIDGET].update(status="active", your_move=True)
        await gw.push_ws(gw.fake.widget_turn(WIDGET))
        await asyncio.sleep(1.5)
        assert len(gw.fake.widget_actions) == 1 and not _game_rows(gw)

    gateway(scenario)


def test_a_long_game_moves_on_to_a_fresh_session(gateway, monkeypatch) -> None:
    async def scenario(gw) -> None:
        adapter = _module(gw, "adapter")
        monkeypatch.setattr(adapter, "GAME_END_GRACE_S", 0.0)
        monkeypatch.setattr(adapter, "_GAME_ROTATE_MESSAGES", 1)
        gw.fake.add_widget(WIDGET, secret=SECRET)
        await _play(gw)
        [(first, chat, _)] = _game_rows(gw)
        assert chat == f"widget-{WIDGET}"
        gw.fake.widgets[WIDGET].update(rev=3, your_move=True)
        await gw.push_ws(gw.fake.widget_turn(WIDGET))
        await gw.wait_for(lambda: len(gw.fake.widget_actions) == 2, 30)
        await gw.wait_for(lambda: [row[1] for row in _game_rows(gw)] == [f"widget-{WIDGET}.g1"], 30)
        assert not gw.query(f"select count(*) from messages where session_id = '{first}'")[0][0]
        assert [chat for _, _, chat in gw.adapter._game_sessions.routes()] == [f"widget-{WIDGET}.g1"]

    gateway(scenario)


def test_a_game_that_ended_offline_is_swept(gateway) -> None:
    async def scenario(gw) -> None:
        gw.fake.add_widget(WIDGET, secret=SECRET)
        await _play(gw, final="Played e4.")
        ids = [row[0] for row in _game_rows(gw)]
        await gw.stop()
        gw.fake.end_widget(WIDGET)
        await gw.start()
        await gw.wait_for(lambda: _gone(gw, ids), 30)
        _assert_no_trace(gw, ids)

    gateway(scenario)


def test_a_game_start_post_is_acked_not_answered(gateway) -> None:
    async def scenario(gw) -> None:
        requests = len(gw.fake.model_requests)
        post = gw.fake.post("Op started a game of chess", widget_id=WIDGET)
        await gw.wait_for(lambda: gw.acked(post), 30)
        await asyncio.sleep(0.5)
        assert str(post["post_id"]) not in [e.message_id for e in gw.events]
        assert len(gw.fake.model_requests) == requests

    gateway(scenario)


def test_the_capability_follows_the_setting(gateway, monkeypatch) -> None:
    async def claimed(gw) -> None:
        await gw.wait_for(lambda: gw.fake.alive_bodies, 30)
        assert gw.fake.alive_bodies[-1] == {"agent_type": "hermes", "capabilities": ["widgets"]}

    gateway(claimed)
    monkeypatch.setenv("CLAWBITS_WIDGETS", "false")
    gateway.fake.alive_bodies.clear()

    async def off(gw) -> None:
        await gw.wait_for(lambda: gw.fake.alive_bodies, 30)
        assert gw.fake.alive_bodies[-1] == {"agent_type": "hermes", "capabilities": []}

    gateway(off)
