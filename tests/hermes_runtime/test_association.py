"""Turn association against the real gateway: only a dispatch token's own hooks settle its items.

Hermes merges some busy follow-ups into a pending head (the absorbed event gets no hooks),
handles /stop in place while a turn runs (interrupting it), and interrupts running agents at
shutdown before it cancels adapter tasks. The journal records each of those without guessing.
"""

from __future__ import annotations

import base64
import sys
from typing import Any

from fake_clawbits import OPERATOR_DM

# A 1x1 PNG, so Hermes treats the post as a photo.
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9aw"
    "AAAABJRU5ErkJggg=="
)


def _states(gw) -> dict[int, tuple[str, str | None]]:
    """pos -> (state, note) of the operator DM's post-lane journal items."""
    rows = gw.adapter._journal.db.execute(
        "SELECT i.pos, i.state, i.note FROM item i JOIN source s ON s.id = i.source_id"
        " WHERE s.locator = ? AND i.lane = 'post'",
        (OPERATOR_DM,),
    )
    return {pos: (state, note) for pos, state, note in rows}


def _state(gw, post: dict[str, Any]) -> tuple[str, str | None] | None:
    return _states(gw).get(post["post_id"])


def _running(gw, post: dict[str, Any]) -> bool:
    """The post's turn is under way: its item is claimed and the model was called."""
    return bool(gw.fake.model_requests) and _state(gw, post) == ("processing", None)


def _force(gw, post: dict[str, Any]) -> None:
    """Hand a pending item to Hermes past the single-flight lane, as a native race would."""
    adapter = gw.adapter
    source = adapter._journal.source("chat", OPERATOR_DM)
    item = adapter._journal.lane_item(source, "post", post["post_id"])
    adapter._hand_off(adapter._dispatch(adapter._channels[OPERATOR_DM], [item], automatic=True))


def _hooked(gw) -> set[str]:
    """Record the dispatch tokens whose processing hooks Hermes fires."""
    tokens: set[str] = set()
    adapter = gw.adapter
    start = adapter.on_processing_start

    async def spy(event: Any) -> None:
        tokens.add((event.metadata or {}).get("clawbits_dispatch"))
        await start(event)

    adapter.on_processing_start = spy
    return tokens


def test_association_merged_follow_up_stays_open_until_restart_review(
    gateway, monkeypatch, tmp_path
):
    image = tmp_path / "photo.png"
    image.write_bytes(_PNG)

    def attachments(client: Any, post: dict[str, Any]) -> tuple[list[str], list[str], list[str]]:
        return ([str(image)], ["image/png"], []) if post.get("files") else ([], [], [])

    async def scenario(gw):
        plugin = sys.modules[type(gw.adapter).__module__]
        monkeypatch.setattr(plugin, "cache_post_attachments", attachments)
        hooked = _hooked(gw)
        gate = gw.fake.hold_model()
        head = gw.fake.post("first question")
        await gw.wait_for(lambda: _running(gw, head))
        photo = gw.fake.post("", files=[{"file_id": "f1", "filename": "photo.png"}])
        caption = gw.fake.post("what is in the picture?")
        await gw.wait_for(lambda: _state(gw, caption) == ("pending", None))
        assert _state(gw, photo) == ("pending", None), "the lane holds follow-ups while a turn runs"
        _force(gw, photo)
        _force(gw, caption)
        await gw.wait_for(lambda: not gw.adapter._handoffs)
        gate.set()
        await gw.wait_for(lambda: _state(gw, photo) == ("processed", "triggered"), 30)
        await gw.wait_for(lambda: not gw.busy(OPERATOR_DM))
        assert _state(gw, head) == ("processed", "triggered")
        assert len(hooked) == 2, "the head and the photo; the merged caption fires no hooks"
        assert _state(gw, caption) == ("processing", None), "an absorbed event never settles"
        await gw.restart()
        assert _state(gw, caption) == ("needs_review", "interrupted")

    gateway(scenario, config={"display": {"busy_input_mode": "queue"}})


def test_association_stop_while_busy_settles_control_and_the_interrupted_turn(gateway):
    async def scenario(gw):
        gw.fake.hold_model()
        work = gw.fake.post("a long job")
        await gw.wait_for(lambda: _running(gw, work))
        stop = gw.fake.post("/stop")
        await gw.wait_for(lambda: _state(gw, stop) == ("processed", "control"))
        # Hermes interrupts the running agent in place, and that turn completes as SUCCESS.
        await gw.wait_for(lambda: _state(gw, work) == ("processed", "triggered"))
        await gw.wait_for(lambda: gw.fake.read_ptr.get(OPERATOR_DM, 0) >= stop["post_id"])
        [event] = [e for e in gw.events if e.message_id == str(stop["post_id"])]
        assert event.allow_gateway_control is True

    gateway(scenario)


def test_association_shutdown_settles_the_interrupted_turn_once(gateway):
    async def scenario(gw):
        gw.fake.hold_model()
        work = gw.fake.post("working on it")
        await gw.wait_for(lambda: _running(gw, work))
        adapter = gw.adapter
        await gw.runner.stop()
        # Shutdown interrupts the running agent (Hermes marks the session to resume) and the
        # turn completes as SUCCESS before adapter tasks are cancelled. A turn cancelled by
        # cancel_background_tasks instead stays processing for restart review (tests/poc).
        assert adapter._stopping, "Hermes calls cancel_background_tasks at shutdown"
        assert _state(gw, work) == ("processed", "triggered")
        gw.runner = gw.adapter = None
        gw.fake.release_model()
        await gw.start()
        await gw.wait_for(lambda: not gw.adapter._handoffs)
        assert _state(gw, work) == ("processed", "triggered")
        handed = [e for e in gw.events if e.message_id == str(work["post_id"])]
        assert len(handed) == 1, "nothing is dispatched again after the restart"

    gateway(scenario)
