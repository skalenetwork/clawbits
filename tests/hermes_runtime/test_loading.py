"""The plugin loads through Hermes's real loader and answers the operator."""

from __future__ import annotations

import inspect
import os
from pathlib import Path

import hermes_cli
from conftest import LAYOUT, pytest_report_header
from fake_clawbits import OPERATOR_DM


def test_plugin_loads_through_hermes_loader_and_replies(gateway, pytestconfig):
    async def scenario(gw):
        adapter_file = Path(inspect.getfile(type(gw.adapter)))
        assert adapter_file.resolve().parent == gw.plugin_dir.resolve(), f"{LAYOUT}: loaded from {adapter_file}"
        # The image's managed config.yaml applies only in the bundled layout.
        assert gw.runner.config.streaming.enabled is (LAYOUT == "bundled")
        assert any("reporting in" in text for text in gw.replies(channel=OPERATOR_DM)), gw.dump()
        assert gw.fake.ws_connected

        gw.fake.script("hi operator")
        start = len(gw.fake.posts)
        post = gw.fake.post("hello")
        await gw.settled(post)
        assert gw.replies(start, OPERATOR_DM) == ["hi operator"], gw.dump()
        assert [e.message_id for e in gw.events] == [str(post["post_id"])]
        assert "hello" in gw.user_inputs()[-1]
        assert ("assistant", "hi operator") in gw.transcript()

    gateway(scenario)

    header = "\n".join(pytest_report_header(pytestconfig))
    assert f"version {hermes_cli.__version__}" in header
    assert f"layout: {LAYOUT}" in header
    assert os.getenv("HERMES_RUNTIME_REV", "unknown") in header
