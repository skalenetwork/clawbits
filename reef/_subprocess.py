"""Shared subprocess plumbing for the CLI-driven runtimes and the nginx exposure.

The msb runtime, the docker runtime, and the nginx exposure all shell out the
same way. This is the single definition of the injectable ``Runner`` type, its
default subprocess implementation, and the ``-e KEY=VALUE`` secret redactor — so
the three call sites don't each re-declare byte-identical copies.
"""

import asyncio
from collections.abc import Awaitable, Callable, Sequence

# A runner takes the full argv (incl. the binary) and returns (rc, stdout, stderr).
# Injectable so the call sites are unit-testable without booting microVMs / nginx.
Runner = Callable[[Sequence[str]], Awaitable[tuple[int, str, str]]]


async def _default_runner(argv: Sequence[str]) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return proc.returncode or 0, out.decode(), err.decode()


def _redact(args: Sequence[str]) -> str:
    """Render argv for error messages with ``-e KEY=VALUE`` secrets masked.
    ``SandboxSpec.env`` carries API keys — never surface them in exceptions/logs.
    """
    masked: list[str] = []
    prev = ""
    for a in args:
        if prev == "-e" and "=" in a:
            a = f"{a.split('=', 1)[0]}=***"
        masked.append(a)
        prev = a
    return " ".join(masked)
