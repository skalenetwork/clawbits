"""``fire_and_forget`` loop affinity (``clawbits/realtime/sse.py``).

Sync FastAPI endpoints publish realtime events from a threadpool thread with
no running loop. The publish must run on the server's main loop — the one
that owns the bus's redis connection pool — or redis operations fail with
"attached to a different loop" and the event is silently dropped (a single
``post.created`` for an IronClaw reply then never reaches connected clients
until a page reload). These tests pin that routing without touching Redis.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import threading

from clawbits.realtime import bus as bus_module
from clawbits.realtime.sse import fire_and_forget


def test_init_bus_captures_running_loop_and_shutdown_clears_it():
    async def _run() -> tuple[asyncio.AbstractEventLoop, asyncio.AbstractEventLoop | None]:
        bus_module.init_bus()
        captured = bus_module.get_publish_loop()
        await bus_module.shutdown_bus()
        return asyncio.get_running_loop(), captured

    running, captured = asyncio.run(_run())
    assert captured is running, "init_bus must record the loop it runs on"
    assert bus_module.get_publish_loop() is None, "shutdown must clear the loop"


def test_fire_and_forget_runs_publish_on_captured_main_loop():
    """A publish issued from a worker thread lands on the captured main loop."""
    ran_on: dict[str, asyncio.AbstractEventLoop] = {}
    done = threading.Event()

    async def _record() -> None:
        ran_on["loop"] = asyncio.get_running_loop()
        done.set()

    async def _main() -> asyncio.AbstractEventLoop:
        main_loop = asyncio.get_running_loop()
        bus_module.set_publish_loop(main_loop)
        coro = _record()
        # Mimic a sync endpoint: call fire_and_forget on a threadpool thread
        # with no running loop of its own.
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            await main_loop.run_in_executor(ex, fire_and_forget, coro)
        await asyncio.to_thread(done.wait, 2.0)
        return main_loop

    try:
        main_loop = asyncio.run(_main())
    finally:
        bus_module.set_publish_loop(None)

    assert done.is_set(), "the scheduled publish never ran"
    assert ran_on.get("loop") is main_loop, "publish ran on the wrong loop"


def test_fire_and_forget_uses_running_loop_directly_when_present():
    """From within a loop (async endpoint) the publish runs on that loop."""
    ran_on: dict[str, asyncio.AbstractEventLoop] = {}

    async def _record() -> None:
        ran_on["loop"] = asyncio.get_running_loop()

    async def _main() -> asyncio.AbstractEventLoop:
        loop = asyncio.get_running_loop()
        # A stale captured loop must be ignored while a real one is running.
        bus_module.set_publish_loop(None)
        fire_and_forget(_record())
        await asyncio.sleep(0.05)  # let the created task run
        return loop

    loop = asyncio.run(_main())
    assert ran_on.get("loop") is loop
