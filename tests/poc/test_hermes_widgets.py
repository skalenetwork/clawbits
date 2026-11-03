"""Chat game tools for Hermes (extensions/hermes/widgets.py, game_sessions.py): the server's tool spec
verbatim, the agent-CLI verbs, which view and game each tool picks, the game-session tool guard, the
``widgets`` capability and the game sessions' deletion. The wake loop is in
test_hermes_widget_wakes.py; tests/hermes_runtime/test_widgets.py runs all of it in real Hermes."""

from __future__ import annotations

import contextlib
import dataclasses
import json
import sqlite3
import sys
import threading
import types
from pathlib import Path
from typing import Any

import pytest

from tests.poc.hermes_stubs import _FakeClawbitsApi, _FakePlatformConfig, _load_hermes_module

REPO = Path(__file__).resolve().parents[2]
WIDGET = "0123456789abcdef0123456789abcdef"
OTHER = "fedcba9876543210fedcba9876543210"
WIDGETS = "/api/agentic/mm/widgets"


def _view(widget_id: str = WIDGET, **fields: Any) -> dict[str, Any]:
    return {
        "widget_id": widget_id, "channel_id": "dm", "kind": "chess", "status": "active", "rev": 4,
        "seat": "white", "waiting_on": ["white"], "your_move": True, "move_deadline": None,
        "players": [], "started_by": "human:7", "text": "Board", "legal": [{"type": "move", "args": {"move": "e4"}}],
        "instructions": "Your move.", "outcome": None, **fields,
    }


def _summary(widget_id: str = WIDGET, **fields: Any) -> dict[str, Any]:
    return {"widget_id": widget_id, "channel_id": "dm", "kind": "chess", "status": "active", "rev": 4,
            "seat": "white", "waiting_on": ["white"], "your_move": True,
            "opponent": {"name": "Ann <x>", "type": "human", "id": "human:7"}, **fields}


@pytest.fixture
def api():
    server = _FakeClawbitsApi()
    yield server
    server.close()


def _session(monkeypatch, chat: str | None = "dm", platform: str = "clawbits", session_id: str = "s1") -> None:
    """The turn's session vars, as Hermes's gateway binds them."""
    env = {"HERMES_SESSION_PLATFORM": platform, "HERMES_SESSION_CHAT_ID": chat or "", "HERMES_SESSION_ID": session_id}
    module = types.SimpleNamespace(get_session_env=lambda name, default="": env.get(name, default))
    monkeypatch.setitem(sys.modules, "gateway.session_context", module)


def _bind(mod, api: _FakeClawbitsApi, **fields: Any) -> None:
    home = mod.account._active_home()
    mod.account.bind_account(
        mod.ClawbitsAccount(hermes_home=home, base_url=api.base_url, agent_id="agent", api_key="k", **fields)
    )


# --- the spec and registration ------------------------------------------------------------------


def test_the_tools_are_the_servers_spec_verbatim() -> None:
    mod = _load_hermes_module()
    shipped = (REPO / "extensions" / "hermes" / "widget_tool_spec.json").read_bytes()
    assert shipped == (REPO / "clawbits" / "widgets" / "tool_spec.json").read_bytes()

    class Ctx:
        def __init__(self) -> None:
            self.tools: dict[str, dict[str, Any]] = {}
            self.hooks: list[tuple[str, Any]] = []

        def register_tool(self, **kwargs: Any) -> None:
            self.tools[kwargs["name"]] = kwargs

        def register_hook(self, name: str, fn: Any) -> None:
            self.hooks.append((name, fn))

        def register_cli_command(self, **_: Any) -> None:
            pass

        def register_platform(self, **_: Any) -> None:
            pass

    ctx = Ctx()
    mod.register(ctx)
    for spec in json.loads(shipped)["tools"]:
        tool = ctx.tools[spec["name"]]
        assert tool["schema"] == {"name": spec["name"], "description": spec["description"], "parameters": spec["inputSchema"]}
        assert tool["description"] == spec["description"]
        assert (tool["toolset"], tool["check_fn"]) == ("clawbits", mod.widgets.available)
    assert ("pre_tool_call", mod.widgets.guard_game_tools) in ctx.hooks


# --- the agent-CLI verbs --------------------------------------------------------------------------


def test_the_cli_verbs_reach_the_widget_routes(api) -> None:
    mod = _load_hermes_module()
    client = mod._ClawbitsCli(mod._default_cli_path(), api.base_url, "k")
    api.respond("GET", WIDGETS, 200, {"widgets": [_summary(), {"bad": 1}]})
    api.respond("GET", f"{WIDGETS}/{WIDGET}", 200, _view())
    api.respond("POST", f"{WIDGETS}/{WIDGET}/actions", 200, {"ok": True, "compact": "ok · rev 5", "your_move": False})

    assert [w["widget_id"] for w in client.list_widgets()] == [WIDGET]
    client.list_widgets(channel_id="dm", waiting=True)
    assert client.get_widget(WIDGET, private=True)["rev"] == 4
    client.get_widget(WIDGET)
    action = {"type": "move", "args": {"move": "e4"}, "rev": 4}
    assert client.act_widget(WIDGET, action, private=True)["compact"] == "ok · rev 5"
    client.alive(["widgets"])
    client.alive()

    listed, waiting, private, public, act, alive, bare = api.writes()
    assert (listed["path"], listed["query"]) == (WIDGETS, {})
    assert waiting["query"] == {"channel_id": "dm", "waiting": "1"}
    assert (private["path"], private["query"], public["query"]) == (f"{WIDGETS}/{WIDGET}", {"private": "1"}, {})
    assert (act["method"], act["query"], act["body"]) == ("POST", {"private": "1"}, action)
    assert alive["body"] == {"agent_type": "hermes", "capabilities": ["widgets"]}
    assert bare["body"] == {"agent_type": "hermes", "capabilities": []}
    assert all(r["headers"]["authorization"] == "Bearer k" for r in api.writes())


def test_an_action_rides_a_private_file_never_argv(monkeypatch) -> None:
    mod = _load_hermes_module()
    seen: list[tuple[str, ...]] = []
    client = mod._ClawbitsCli("cli", "https://x", "k")

    def run(*args: str) -> Any:
        seen.append(args)
        ref = args[args.index("--json") + 1]
        assert json.loads(Path(ref[1:]).read_text()) == {"type": "fire", "args": {"at": "B7"}}
        return {"ok": True, "compact": "ok", "your_move": False}

    monkeypatch.setattr(client, "_run", run)
    client.act_widget(WIDGET, {"type": "fire", "args": {"at": "B7"}})
    [args] = seen
    assert "B7" not in " ".join(args) and not Path(args[args.index("--json") + 1][1:]).exists()


# --- which game and which view ------------------------------------------------------------------


def test_in_a_chat_turn_get_reads_the_chats_game_publicly(api, monkeypatch) -> None:
    mod = _load_hermes_module()
    _bind(mod, api)
    _session(monkeypatch, chat="dm")
    api.respond("GET", WIDGETS, 200, {"widgets": [_summary()]})
    api.respond("GET", f"{WIDGETS}/{WIDGET}", 200, _view(legal=[], instructions="Talk about it."))

    text = mod.widgets.widget_get_tool({})
    assert text.startswith(f"[Clawbits chat game · chess · widget_id {WIDGET} · rev 4]\nTalk about it.")
    assert "legal:" not in text and text.endswith("\nBoard")
    listed, view = api.writes()
    assert listed["query"] == {"channel_id": "dm"} and view["query"] == {}


def test_in_its_own_session_get_and_act_play_the_game_privately(api, monkeypatch) -> None:
    mod = _load_hermes_module()
    _bind(mod, api)
    _session(monkeypatch, chat=f"widget-{WIDGET}.g2")
    api.respond("GET", f"{WIDGETS}/{WIDGET}", 200, _view())
    api.respond("POST", f"{WIDGETS}/{WIDGET}/actions", 200, {
        "ok": True, "compact": "ok · rev 5 · waiting on you", "your_move": True, "view": _view(rev=5),
    })

    assert 'legal: [{"args":{"move":"e4"},"type":"move"}]' in mod.widgets.widget_get_tool({})  # the CLI sorts keys
    text = mod.widgets.widget_act_tool({"type": " move ", "args": {"move": "e4"}, "rev": 4})
    assert text.startswith("ok · rev 5 · waiting on you\n\n[Clawbits chat game · chess · widget_id")
    get, act = api.writes()
    assert get["query"] == {"private": "1"}
    assert (act["query"], act["body"]) == ({"private": "1"}, {"type": "move", "args": {"move": "e4"}, "rev": 4})


def test_act_refuses_outside_its_games_own_session(api, monkeypatch) -> None:
    mod = _load_hermes_module()
    _bind(mod, api)
    _session(monkeypatch, chat="dm")
    assert "only in the game's own turn" in mod.widgets.widget_act_tool({"widget_id": WIDGET, "type": "move"})
    _session(monkeypatch, chat=f"widget-{WIDGET}")
    assert "it plays only that game" in mod.widgets.widget_act_tool({"widget_id": OTHER, "type": "move"})
    assert "must not be blank" in mod.widgets.widget_act_tool({"type": " "})
    _session(monkeypatch, chat=f"widget-{WIDGET}", platform="telegram")
    assert "only in the game's own turn" in mod.widgets.widget_act_tool({"type": "move"})
    assert api.writes() == []


def test_refusals_and_errors_read_as_text(api, monkeypatch) -> None:
    mod = _load_hermes_module()
    _bind(mod, api)
    _session(monkeypatch, chat=f"widget-{WIDGET}")
    api.respond("POST", f"{WIDGETS}/{WIDGET}/actions", 200, {
        "ok": False, "code": "stale_rev", "message": "The game moved on", "view": _view(rev=6),
    })
    assert mod.widgets.widget_act_tool({"type": "move"}).startswith("refused (stale_rev): The game moved on\n\n[Clawbits")
    api.respond("POST", f"{WIDGETS}/{WIDGET}/actions", 404, {"detail": "Widget not found"})
    assert "No Clawbits chat game" in mod.widgets.widget_act_tool({"type": "move"})
    assert "No Clawbits chat game" in mod.widgets.widget_get_tool({"widget_id": "../x"})


def test_list_fences_opponent_names(api, monkeypatch) -> None:
    mod = _load_hermes_module()
    _bind(mod, api)
    _session(monkeypatch)
    api.respond("GET", WIDGETS, 200, {"widgets": [_summary(), _summary(OTHER, your_move=False, waiting_on=["black"])]})
    text = mod.widgets.widget_list_tool({"waiting": True})
    assert text.splitlines()[:3] == [
        "Clawbits chat games waiting on your move (2):",
        f"- widget_id {WIDGET} · chess · rev 4 · chat dm · you play white · your move",
        f"- widget_id {OTHER} · chess · rev 4 · chat dm · you play white · waiting on black",
    ]
    assert text.endswith(f"{OTHER} opponent: Ann <x> (human)\nUNTRUSTED>>>")
    assert api.writes()[0]["query"] == {"waiting": "1"}
    api.respond("GET", WIDGETS, 200, {"widgets": []})
    assert mod.widgets.widget_list_tool({}) == "You have no active Clawbits chat games."


def test_tools_need_the_running_gateway(monkeypatch) -> None:
    mod = _load_hermes_module()
    _session(monkeypatch, chat=f"widget-{WIDGET}")
    assert mod.widgets.available() is False
    assert "not running" in mod.widgets.widget_act_tool({"type": "move"})


# --- the guard ------------------------------------------------------------------------------------


def test_a_game_session_runs_only_the_game_tools(monkeypatch) -> None:
    widgets = _load_hermes_module().widgets
    _session(monkeypatch, chat=f"widget-{WIDGET}", session_id="game-1")
    guard = widgets.guard_game_tools
    for name, args in [
        ("clawbits_widget_act", {"type": "move"}), ("clawbits_widget_get", {}), ("tool_search", {"queries": ["x"]}),
        ("tool_describe", {"names": ["clawbits_widget_act"]}),
        ("tool_call", {"calls": [{"name": "clawbits_widget_act", "arguments": {}}]}),
    ]:
        assert guard(tool_name=name, args=args, session_id="game-1") is None, name
    for name, args in [
        ("send_message", {"target": "dm", "message": "my cards"}), ("memory", {"action": "add"}),
        ("clawbits_send_email", {}), ("terminal", {"command": "ls"}), ("session_search", {"query": "x"}),
        ("tool_call", {"calls": [{"name": "clawbits_widget_act"}, {"name": "send_message"}]}),
        ("tool_call", {"calls": []}),
    ]:
        verdict = guard(tool_name=name, args=args, session_id="game-1")
        assert verdict == {"action": "block", "message": widgets.SILENT_REASON}, name
    # A call that lost its chat context is still told by its session id.
    _session(monkeypatch, chat=None, platform="")
    assert guard(tool_name="memory", args={}, session_id="game-1")["action"] == "block"
    assert guard(tool_name="memory", args={}, session_id="chat-1") is None


def _state_db(home: Path, rows: list[tuple[str, str, str | None, str | None]]) -> None:
    home.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(home / "state.db") as db:
        db.execute("create table sessions (id text primary key, source text, chat_id text, session_key text, parent_session_id text)")
        db.execute("create table messages (id integer primary key, session_id text, content text)")
        for sid, chat, key, parent in rows:
            db.execute("insert into sessions values (?, 'clawbits', ?, ?, ?)", (sid, chat, key, parent))
            db.execute("insert into messages (session_id, content) values (?, 'hand: A♠ K♦')", (sid,))


def test_chat_turns_cannot_search_a_game_session(monkeypatch, tmp_path) -> None:
    mod = _load_hermes_module()
    home = mod.account._active_home()
    _session(monkeypatch, chat="dm")
    guard = mod.widgets.guard_game_tools
    assert guard(tool_name="session_search", args={"query": "cards"}) is None, "no state.db: no game"
    _state_db(home, [("chat-1", "dm", "agent:main:clawbits:dm:dm", None)])
    assert guard(tool_name="session_search", args={"query": "cards"}) is None, "no game session"
    with sqlite3.connect(home / "state.db") as db:
        db.execute("insert into sessions values ('game-1', 'clawbits', ?, 'k', null)", (f"widget-{WIDGET}",))
    blocked = {"action": "block", "message": mod.widgets.PRIVATE_REASON}
    assert guard(tool_name="session_search", args={"query": "cards"}) == blocked
    assert guard(tool_name="session_search", args={"session_id": "game-1"}) == blocked
    assert guard(tool_name="session_search", args={"session_id": "chat-1"}) is None
    (home / "state.db").write_text("not a database")
    assert guard(tool_name="session_search", args={"query": "cards"}) == blocked, "unreadable: refused"
    assert guard(tool_name="session_search", args={"session_id": "chat-1"}) == blocked, "targeted too"


def test_chat_turns_cannot_search_another_profiles_game_session(monkeypatch, tmp_path) -> None:
    """session_search reads the store a ``profile`` or a ``<profile>/<id>`` session id names, as
    Hermes's ``_dispatch`` resolves it: the guard checks that store, not this profile's."""
    mod = _load_hermes_module()
    home = mod.account._active_home()
    root = tmp_path / "profiles"

    def profile_dir(name: str) -> Path:
        if name != name.strip().lower() or "/" in name:
            raise ValueError(f"Invalid profile name {name!r}")
        return home if name == "default" else root / name

    profiles = types.SimpleNamespace(get_profile_dir=profile_dir, normalize_profile_name=lambda n: n.strip().lower())
    monkeypatch.setitem(sys.modules, "hermes_cli.profiles", profiles)
    _session(monkeypatch, chat="dm")
    guard = mod.widgets.guard_game_tools
    blocked = {"action": "block", "message": mod.widgets.PRIVATE_REASON}
    _state_db(home, [("chat-1", "dm", "agent:main:clawbits:dm:dm", None)])  # this profile: no game
    _state_db(root / "b", [("chat-b", "dm", "agent:b:clawbits:dm:dm", None), ("game-b", f"widget-{OTHER}", "kb", None)])
    _state_db(root / "c", [("chat-c", "dm", "agent:c:clawbits:dm:dm", None)])

    for args in [
        {"query": "cards", "profile": "b"}, {"profile": " B "}, {"session_id": "game-b", "profile": "b"},
        {"session_id": "b/game-b"}, {"session_id": "b/game-b", "around_message_id": 1},
        {"session_id": "c/game-b", "profile": "b"}, {"query": "cards", "profile": "../b"}, {"session_id": "B/game-b"},
    ]:
        assert guard(tool_name="session_search", args=args) == blocked, args
    for args in [
        {"session_id": "b/chat-b"}, {"session_id": "chat-b", "profile": "b"}, {"query": "cards", "profile": "c"},
        {"query": "cards", "profile": "nobody"}, {"session_id": "b/game-b", "profile": "c"}, {"query": "cards"},
    ]:
        assert guard(tool_name="session_search", args=args) is None, args
    # This profile's own game, named the way a session link names it.
    with sqlite3.connect(home / "state.db") as db:
        db.execute("insert into sessions values ('game-1', 'clawbits', ?, 'k', null)", (f"widget-{WIDGET}",))
    assert guard(tool_name="session_search", args={"session_id": "default/game-1"}) == blocked
    assert guard(tool_name="session_search", args={"query": "cards", "profile": "default"}) == blocked
    for args in [{"session_id": "default/chat-1"}, {"session_id": "/chat-1"}, {"query": "cards", "profile": "c"}]:
        assert guard(tool_name="session_search", args=args) is None, args
    monkeypatch.delitem(sys.modules, "hermes_cli.profiles")
    assert guard(tool_name="session_search", args={"session_id": "b/chat-b"}) == blocked, "unresolved: refused"


# --- the capability -------------------------------------------------------------------------------


def _hermes(monkeypatch, *, toolset: str | None = "clawbits", config: dict[str, Any] | None = None,
            enabled: set[str] | None = None) -> list[dict[str, Any]]:
    """Stub Hermes's tool registry, gateway config and platform-toolset resolver."""
    seen: list[dict[str, Any]] = []
    registry = types.SimpleNamespace(get_toolset_for_tool=lambda name: toolset if name.startswith("clawbits_") else None)
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.registry", types.SimpleNamespace(registry=registry))
    monkeypatch.setitem(sys.modules, "gateway.run", types.SimpleNamespace(_load_gateway_config=lambda: dict(config or {})))

    def platform_tools(cfg: dict[str, Any], platform: str) -> set[str]:
        seen.append(cfg)
        listed = set(cfg["platform_toolsets"][platform])
        return listed if enabled is None else listed & enabled

    monkeypatch.setitem(sys.modules, "hermes_cli.tools_config", types.SimpleNamespace(_get_platform_tools=platform_tools))
    return seen


def test_the_capability_is_claimed_only_when_a_game_can_be_played(api, monkeypatch) -> None:
    mod = _load_hermes_module()
    account = mod.ClawbitsAccount(hermes_home=Path("/h"), base_url="https://x", agent_id="agent", api_key="k")
    seen = _hermes(monkeypatch, config={"platform_toolsets": {"clawbits": ["hermes-clawbits"]}})
    assert mod.widgets.capability(account) == ([], "not_bound")
    _bind(mod, api)
    assert mod.widgets.capability(account) == (["widgets"], "on")
    assert seen[-1]["platform_toolsets"]["clawbits"] == ["clawbits", "no_mcp"], "checked as a game's run gets it"
    assert mod.widgets.capability(dataclasses.replace(account, widgets=False)) == ([], "disabled")
    _hermes(monkeypatch, config={"memory": {"provider": "honcho"}})
    assert mod.widgets.capability(account) == ([], "memory_provider")
    _hermes(monkeypatch, config={"memory": {"provider": "builtin"}})
    assert mod.widgets.capability(account) == (["widgets"], "on")
    _hermes(monkeypatch, enabled=set())
    assert mod.widgets.capability(account) == ([], "toolset_disabled")
    _hermes(monkeypatch, toolset=None)
    assert mod.widgets.capability(account) == ([], "tools_unavailable")


def test_the_setting_turns_games_off(monkeypatch) -> None:
    mod = _load_hermes_module()
    monkeypatch.setenv("CLAWBITS_WIDGETS", "false")
    assert mod.resolve_account(_FakePlatformConfig(extra={"api_key": "k", "agent_id": "a"})).widgets is False
    assert mod.resolve_account(_FakePlatformConfig(extra={"api_key": "k", "agent_id": "a", "widgets": True})).widgets
    monkeypatch.delenv("CLAWBITS_WIDGETS")
    assert mod.resolve_account(_FakePlatformConfig(extra={"api_key": "k", "agent_id": "a"})).widgets is True


# --- the game sessions ----------------------------------------------------------------------------


class _Entry:
    def __init__(self, key: str, sid: str, chat: str) -> None:
        self.session_key, self.session_id = key, sid
        self.origin = types.SimpleNamespace(chat_id=chat)


class _Store:
    """SessionStore's routing index as min/current have it; ``remove`` adds latest's API."""

    def __init__(self, entries: list[_Entry], db: Any, *, remove: bool = False) -> None:
        self._entries = {e.session_key: e for e in entries}
        self._lock = threading.Lock()
        self._db = db
        self.saves = 0
        if remove:
            self.remove_by_session_id = self._remove

    def list_sessions(self) -> list[_Entry]:
        return list(self._entries.values())

    def _save(self) -> None:
        assert self._lock.locked(), "saved under the store's lock"
        self.saves += 1

    def _remove(self, sid: str) -> int:
        dropped = [k for k, e in self._entries.items() if e.session_id == sid]
        for key in dropped:
            del self._entries[key]
        return len(dropped)


class _Db:
    def __init__(self, home: Path, *, guards: bool = False, skip: bool = False) -> None:
        self.home, self.calls, self.skip = home, [], skip
        if guards:
            self.delete_sessions = self._guarded

    def delete_sessions(self, ids: list[str], sessions_dir: Path | None = None) -> int:
        self.calls.append((sorted(ids), {"sessions_dir": sessions_dir}))
        with sqlite3.connect(self.home / "state.db") as db:
            db.executemany("delete from sessions where id = ?", [(i,) for i in ids])
        return len(ids)

    def _guarded(self, ids, sessions_dir=None, exclude_active_write_guards=False, skipped_ids=None, include_compression_chain=False):
        self.calls.append((sorted(ids), {"sessions_dir": sessions_dir, "guards": exclude_active_write_guards}))
        if self.skip:
            skipped_ids.append(ids[0])
            return 0
        return len(ids)


KEY = f"agent:main:clawbits:dm:widget-{WIDGET}"


def _game(tmp_path: Path, **db: Any) -> tuple[Any, Any, _Store, _Db, list[str]]:
    mod = _load_hermes_module()
    home = tmp_path / "home"
    _state_db(home, [
        ("g0", f"widget-{WIDGET}", KEY, None), ("g0b", f"widget-{WIDGET}", KEY, "g0"),
        ("g1", f"widget-{WIDGET}.g1", KEY + ".g1", None), ("o1", f"widget-{OTHER}", "o", None),
        ("chat", "dm", "agent:main:clawbits:dm:dm", None),
    ])
    database = _Db(home, **db)
    store = _Store([_Entry(KEY, "g0b", f"widget-{WIDGET}"), _Entry(KEY + ".g1", "g1", f"widget-{WIDGET}.g1"),
                    _Entry("agent:main:clawbits:dm:dm", "chat", "dm")], database)
    evicted: list[str] = []
    runner = types.SimpleNamespace(_evict_cached_agent=evicted.append, config=types.SimpleNamespace(sessions_dir=None))
    adapter = types.SimpleNamespace(_session_store=store, gateway_runner=runner)
    return mod, mod.game_sessions.GameSessions(home, adapter), store, database, evicted


def test_a_games_sessions_are_found_and_sized(tmp_path) -> None:
    _, sessions, *_ = _game(tmp_path)
    assert sessions.games() == {WIDGET: {0, 1}, OTHER: {0}}
    assert sessions.size(f"widget-{WIDGET}")[0] == 2
    assert sessions.size("widget-none") == (0, 0)


def test_an_ended_game_is_deleted_whole(tmp_path) -> None:
    _, sessions, store, db, evicted = _game(tmp_path)
    assert sessions.delete(WIDGET, None, busy=lambda key: key == KEY) == "busy"
    assert db.calls == [] and evicted == []

    assert sessions.delete(WIDGET, None, busy=lambda key: False) == "deleted"
    [(ids, kwargs)] = db.calls
    assert ids == ["g0", "g0b", "g1"] and kwargs == {"sessions_dir": tmp_path / "home" / "sessions"}
    assert sorted(evicted) == [KEY, KEY + ".g1"]
    assert list(store._entries) == ["agent:main:clawbits:dm:dm"] and store.saves == 1
    assert sessions.games() == {OTHER: {0}}
    assert sessions.delete(WIDGET, None, busy=lambda key: False) == "none"


def test_a_retired_generation_goes_alone(tmp_path) -> None:
    _, sessions, store, db, _ = _game(tmp_path)
    assert sessions.delete(WIDGET, [0], busy=lambda key: False) == "deleted"
    assert db.calls[0][0] == ["g0", "g0b"]
    assert sorted(store._entries) == ["agent:main:clawbits:dm:dm", KEY + ".g1"]


def test_latest_hermes_deletes_with_its_write_guards(tmp_path) -> None:
    _, sessions, store, db, _ = _game(tmp_path, guards=True, skip=True)
    store.remove_by_session_id = store._remove
    assert sessions.delete(WIDGET, [1], busy=lambda key: False) == "busy", "a held row is skipped"
    assert db.calls[0][1]["guards"] is True and KEY + ".g1" in store._entries
    db.skip = False
    assert sessions.delete(WIDGET, [1], busy=lambda key: False) == "deleted"
    assert KEY + ".g1" not in store._entries and store.saves == 0, "remove_by_session_id did it"


def test_transcript_files_go_from_the_profiles_home_and_the_stores_directory(tmp_path) -> None:
    """A multiplexed gateway's one store is the launch profile's; a served profile's turns write
    their request dumps and diverted JSONL under its own home."""
    _, sessions, store, db, _ = _game(tmp_path)
    own, launch = tmp_path / "home" / "sessions", tmp_path / "launch" / "sessions"
    store.sessions_dir = launch
    files = {d / name for d in (own, launch) for name in ("g0.json", "g0b.jsonl", "request_dump_g1_1.json", "chat.jsonl")}
    for path in files:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("hand: A♠ K♦")
    assert sessions.delete(WIDGET, None, busy=lambda key: False) == "deleted"
    assert db.calls[0][1] == {"sessions_dir": own}, "Hermes's delete: the profile's own home"
    assert sorted(p.name for p in launch.iterdir()) == ["chat.jsonl"], "and the store's directory"


def test_a_moves_final_text_leaves_the_delivery_ledger(tmp_path, monkeypatch) -> None:
    mod, sessions, *_ = _game(tmp_path)
    ledger = tmp_path / "ledger.db"
    with sqlite3.connect(ledger) as conn:
        conn.execute("create table delivery_obligations (obligation_id text, session_key text, chat_id text, content text)")
        conn.executemany("insert into delivery_obligations values (?, ?, ?, 'Calling with pocket kings')", [
            ("a", KEY, f"widget-{WIDGET}"), ("b", KEY + ".g1", f"widget-{WIDGET}.g1"),
            ("c", f"agent:b:clawbits:dm:widget-{WIDGET}", f"widget-{WIDGET}"), ("d", "agent:main:clawbits:dm:dm", "dm"),
        ])
    lock = threading.Lock()

    @contextlib.contextmanager
    def transaction():
        assert lock.locked(), "under the ledger's own lock"
        conn = sqlite3.connect(ledger)
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    monkeypatch.setitem(sys.modules, "gateway.delivery_ledger", types.SimpleNamespace(_DB_LOCK=lock, _transaction=transaction))
    assert sessions.delete(WIDGET, [1], busy=lambda key: False) == "deleted"
    assert sessions.delete(WIDGET, None, busy=lambda key: False) == "deleted"
    with sqlite3.connect(ledger) as conn:
        left = [row[0] for row in conn.execute("select obligation_id from delivery_obligations order by 1")]
    assert left == ["c", "d"], "only this profile's game keys"


def test_another_profiles_game_sessions_are_left_alone(tmp_path) -> None:
    _, sessions, store, _, _ = _game(tmp_path)
    theirs = f"agent:b:clawbits:dm:widget-{WIDGET}"
    store._entries[theirs] = _Entry(theirs, "b1", f"widget-{WIDGET}")
    sessions._adapter._game_key = lambda chat: f"agent:main:clawbits:dm:{chat}"
    assert theirs not in [key for key, _, _ in sessions.routes()], "one store holds every profile's"
    assert sessions.delete(WIDGET, None, busy=lambda key: False) == "deleted"
    assert theirs in store._entries
