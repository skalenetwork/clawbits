"""Persistence seam for sandbox state. ``InMemorySandboxStore`` covers
tests and single-process dev; a SQL-backed store (Reef's own schema) lands
with the bare-metal cutover.
"""

from typing import Protocol

from reef.models import Sandbox


class SandboxStore(Protocol):
    async def get(self, sandbox_id: str) -> Sandbox | None: ...
    async def put(self, sandbox: Sandbox) -> None: ...
    async def delete(self, sandbox_id: str) -> None: ...
    async def list(self) -> list[Sandbox]: ...


class InMemorySandboxStore:
    """Dict-backed store. Not durable; for tests and single-process dev."""

    def __init__(self) -> None:
        self._items: dict[str, Sandbox] = {}

    async def get(self, sandbox_id: str) -> Sandbox | None:
        return self._items.get(sandbox_id)

    async def put(self, sandbox: Sandbox) -> None:
        self._items[sandbox.sandbox_id] = sandbox

    async def delete(self, sandbox_id: str) -> None:
        self._items.pop(sandbox_id, None)

    async def list(self) -> list[Sandbox]:
        return list(self._items.values())
