"""``AgentRuntime`` + ``FleetRuntime`` backed by the ``docker`` CLI — the
local-dev runtime (the same subprocess pattern as ``MicrosandboxRuntime``).

Why a second runtime: on the dev Mac, microsandbox's host↔guest relay
(``exec``/``-p``/``logs``) is unreliable, so local agents run as Docker
containers (OrbStack) where port-forwarding and exec work; prod uses
``MicrosandboxRuntime`` on Linux. Both satisfy ``AdminRuntime``, so the manager
and the fleet API are unchanged — the choice is config (see
``reef.runtime_factory``).

Two intentional deltas from msb, both fine for single-tenant local dev:
- **Egress allowlist** — Docker has no native per-container egress allowlist
  (msb's ``--net-rule``), so ``spec.net_allow`` is ignored here.
- **Fleet scope** — every Reef container is stamped with a ``reef.managed``
  label so the fleet view shows only Reef's agents, not every container.
"""

import json
import os
import re
import shutil
from datetime import datetime

from reef._subprocess import Runner, _default_runner, _redact
from reef.errors import RuntimeUnavailable
from reef.image_ops import (
    BuildImageSpec,
    ImageInfo,
    activate_image,
    build_image_stream,
    list_local_images,
)
from reef.image_ops import image_env as _image_env
from reef.runtime import MetricsSample, SandboxInfo, SandboxSpec, SandboxState
from reef.status import read_status_file

# Stamped on every Reef-created container; scopes the fleet view to Reef agents.
LABEL = "reef.managed=true"

# docker `State.Status` enum -> Reef lifecycle state.
_STATUS_MAP = {
    "running": SandboxState.RUNNING,
    "restarting": SandboxState.RUNNING,
    "created": SandboxState.STOPPED,
    "exited": SandboxState.STOPPED,
    "paused": SandboxState.STOPPED,
    "removing": SandboxState.STOPPED,
    "dead": SandboxState.FAILED,
}

_SIZE_UNITS = {
    "b": 1,
    "kb": 1000,
    "mb": 1000**2,
    "gb": 1000**3,
    "tb": 1000**4,
    "kib": 1024,
    "mib": 1024**2,
    "gib": 1024**3,
    "tib": 1024**4,
}


def _parse_dt(value: object) -> datetime | None:
    """Parse a timestamp from docker output — ISO (``inspect .Created``) or the
    Go layout ``2006-01-02 15:04:05 -0700 MST`` (``ps .CreatedAt``)."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        pass
    parts = value.split()
    if len(parts) >= 3:
        try:
            return datetime.strptime(" ".join(parts[:3]), "%Y-%m-%d %H:%M:%S %z")
        except ValueError:
            return None
    return None


def _parse_size(value: object) -> int:
    """``"772.5MiB"`` / ``"23.4kB"`` / ``"0B"`` -> bytes (binary for *iB, decimal otherwise)."""
    if not isinstance(value, str):
        return 0
    m = re.match(r"\s*([0-9.]+)\s*([a-zA-Z]*)", value)
    if not m or not m.group(1):
        return 0
    return int(float(m.group(1)) * _SIZE_UNITS.get(m.group(2).lower(), 1))


def _pct(value: object) -> float:
    """``"67.55%"`` -> ``67.55``."""
    if not isinstance(value, str):
        return 0.0
    try:
        return float(value.strip().rstrip("%"))
    except ValueError:
        return 0.0


def _split_pair(value: object) -> tuple[str, str]:
    """``"772.5MiB / 7.806GiB"`` -> ``("772.5MiB", "7.806GiB")``."""
    if isinstance(value, str) and "/" in value:
        a, b = value.split("/", 1)
        return a.strip(), b.strip()
    return "", ""


def _state_from(d: dict) -> SandboxState:
    """Prefer docker's ``State`` enum; fall back to parsing the ``Status`` string."""
    state = str(d.get("State") or "").lower()
    if not state:
        status = str(d.get("Status") or "").lower()
        state = "running" if status.startswith("up") else status.split()[0] if status else ""
    return _STATUS_MAP.get(state, SandboxState.FAILED)


def _metrics_from(d: dict) -> MetricsSample:
    mem_used, mem_lim = _split_pair(d.get("MemUsage"))
    net_rx, net_tx = _split_pair(d.get("NetIO"))
    blk_r, blk_w = _split_pair(d.get("BlockIO"))
    return MetricsSample(
        name=str(d.get("Name") or d.get("Container") or ""),
        cpu_percent=_pct(d.get("CPUPerc")),
        memory_bytes=_parse_size(mem_used),
        memory_limit_bytes=_parse_size(mem_lim),
        disk_read_bytes=_parse_size(blk_r),
        disk_write_bytes=_parse_size(blk_w),
        net_rx_bytes=_parse_size(net_rx),
        net_tx_bytes=_parse_size(net_tx),
    )


def _iter_json_lines(out: str):
    """docker ``--format '{{json .}}'`` emits one JSON object per line."""
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


_HOST_PORT_RE = re.compile(r":(\d+)->")


def _host_ports(ports_field: str) -> set[int]:
    """Published host ports from a docker `ps` ``Ports`` string, e.g.
    ``"127.0.0.1:19000->18789/tcp, 0.0.0.0:8080->80/tcp"`` -> ``{19000, 8080}``."""
    return {int(p) for p in _HOST_PORT_RE.findall(ports_field or "")}


class DockerRuntime:
    def __init__(
        self,
        *,
        docker_bin: str | None = None,
        runner: Runner | None = None,
        state_dir: str | None = None,
    ) -> None:
        self._docker = (
            docker_bin or os.getenv("REEF_DOCKER_BIN") or shutil.which("docker") or "docker"
        )
        self._run = runner or _default_runner
        # Per-agent host state Reef can read: the status mount lives under
        # <state_dir>/agents/<id> and is bind-mounted into the container.
        self._state_dir = state_dir or os.getenv("REEF_STATE_DIR") or os.path.expanduser("~/.reef")

    async def _call(self, *args: str) -> str:
        rc, out, err = await self._run([self._docker, *args])
        if rc != 0:
            detail = err.strip() or out.strip()
            raise RuntimeUnavailable(f"`docker {_redact(args)}` failed (rc={rc}): {detail}")
        return out

    async def _ensure_volume(self, name: str) -> None:
        # `docker volume create` is idempotent — returns the name (rc 0) if it exists.
        await self._call("volume", "create", name)

    def _status_host_dir(self, handle: str) -> str:
        """Host dir bind-mounted into the agent for its volunteered status file."""
        return os.path.join(self._state_dir, "agents", handle)

    async def create(self, spec: SandboxSpec) -> str:
        await self._ensure_volume(spec.volume)
        for extra_name, _ in spec.extra_volumes:
            await self._ensure_volume(extra_name)
        # Mirror msb's `--replace`: drop any stale container of the same name first.
        await self._run([self._docker, "rm", "-f", spec.sandbox_id])
        argv: list[str] = [
            "run",
            "-d",
            "--name",
            spec.sandbox_id,
            "--label",
            LABEL,
            # Make the host reachable from inside the agent as `host.docker.internal`
            # so it can call services bound to the host's loopback during local dev
            # — notably the clawbits backend on localhost:8000 (set the agent's
            # CLAWBITS_ENDPOINT to http://host.docker.internal:8000). The name is
            # predefined on Docker Desktop/OrbStack (Mac), so re-adding is a harmless
            # no-op there; on Linux Docker it doesn't exist unless we add it.
            # `host-gateway` is Docker's built-in alias for the host's gateway IP.
            "--add-host",
            "host.docker.internal:host-gateway",
            "--cpus",
            str(spec.limits.cpus),
            "--memory",
            f"{spec.limits.memory_mb}m",
            "-v",
            f"{spec.volume}:{spec.volume_dest}",
        ]
        for extra_name, extra_dest in spec.extra_volumes:
            argv += ["-v", f"{extra_name}:{extra_dest}"]
        if spec.status_dest:
            # Bind a host dir the agent writes its status.json to; Reef reads it back.
            host_dir = self._status_host_dir(spec.sandbox_id)
            os.makedirs(host_dir, exist_ok=True)
            argv += ["-v", f"{host_dir}:{spec.status_dest}"]
        for key, value in spec.env.items():
            argv += ["-e", f"{key}={value}"]
        for forward in spec.ports:
            argv += ["-p", forward]
        # spec.net_allow intentionally ignored — no native Docker egress allowlist.
        argv.append(spec.image)
        await self._call(*argv)
        return spec.sandbox_id  # the container name is the handle

    async def start(self, handle: str) -> None:
        # `docker start` is a no-op (rc 0) on an already-running container.
        await self._call("start", handle)

    async def stop(self, handle: str) -> None:
        rc, out, err = await self._run([self._docker, "stop", handle])
        if rc != 0 and "no such container" not in (err + out).lower():
            raise RuntimeUnavailable(f"`docker stop {handle}` failed: {err.strip() or out.strip()}")

    async def destroy(self, handle: str) -> None:
        rc, out, err = await self._run([self._docker, "rm", "-f", handle])
        if rc != 0 and "no such container" not in (err + out).lower():
            raise RuntimeUnavailable(f"`docker rm {handle}` failed: {err.strip() or out.strip()}")
        # Drop the per-agent status dir so a recreated id starts fresh (no stale versions).
        shutil.rmtree(self._status_host_dir(handle), ignore_errors=True)

    async def status(self, handle: str) -> SandboxState:
        # Pull the exit code alongside the status: a crash (``exited`` with a non-zero
        # code) reads as FAILED, not STOPPED, so the reconciler's ``on-failure`` policy
        # can tell a crash from a clean stop. (msb reports ``failed`` natively.)
        rc, out, _ = await self._run(
            [self._docker, "inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", handle]
        )
        if rc != 0:
            return SandboxState.DESTROYED  # no such container
        parts = out.split()
        state = parts[0].lower() if parts else ""
        st = _STATUS_MAP.get(state, SandboxState.FAILED)
        if st is SandboxState.STOPPED and state == "exited":
            code = int(parts[1]) if len(parts) > 1 and parts[1].lstrip("-").isdigit() else 0
            if code != 0:
                return SandboxState.FAILED
        return st

    # ── Fleet / observability (admin API) ──────────────────────────────────

    async def list_sandboxes(self) -> list[SandboxInfo]:
        out = await self._call("ps", "-a", "--filter", f"label={LABEL}", "--format", "{{json .}}")
        return [
            SandboxInfo(
                name=str(d.get("Names", "")),
                image=str(d.get("Image", "")),
                state=_state_from(d),
                created_at=_parse_dt(d.get("CreatedAt")),
            )
            for d in _iter_json_lines(out)
        ]

    async def metrics(self) -> list[MetricsSample]:
        # Best-effort; lists all running containers. The fleet merge keys by name,
        # so any non-Reef containers' samples are simply ignored downstream.
        rc, out, _ = await self._run(
            [self._docker, "stats", "--no-stream", "--format", "{{json .}}"]
        )
        if rc != 0:
            return []
        return [_metrics_from(d) for d in _iter_json_lines(out)]

    async def metrics_for(self, handle: str) -> MetricsSample | None:
        rc, out, _ = await self._run(
            [self._docker, "stats", "--no-stream", "--format", "{{json .}}", handle]
        )
        if rc != 0 or not out.strip():
            return None
        return next((_metrics_from(d) for d in _iter_json_lines(out)), None)

    async def inspect(self, handle: str) -> dict:
        """Return docker's inspect normalized to the same ``{"config": {...}}``
        shape ``FleetService`` expects from msb, so the admin API stays uniform.
        """
        out = await self._call("inspect", handle)
        try:
            arr = json.loads(out)
        except json.JSONDecodeError as e:
            raise RuntimeUnavailable(f"`docker inspect {handle}` returned non-JSON") from e
        obj = arr[0] if isinstance(arr, list) and arr else {}
        cfg = obj.get("Config") or {}
        host = obj.get("HostConfig") or {}
        nano_cpus = host.get("NanoCpus") or 0
        memory = host.get("Memory") or 0
        return {
            "config": {
                "image": {"Oci": {"reference": cfg.get("Image", "")}},
                "cpus": (nano_cpus / 1e9) if nano_cpus else None,
                "memory_mib": (memory // (1024 * 1024)) if memory else None,
                "entrypoint": cfg.get("Entrypoint") or [],
                "cmd": cfg.get("Cmd") or [],
                "env": [kv.split("=", 1) for kv in (cfg.get("Env") or []) if "=" in kv],
                "mounts": [
                    {
                        "host": m.get("Name") or m.get("Source", ""),
                        "guest": m.get("Destination", ""),
                        "type": m.get("Type", ""),
                        "options": {"readonly": not m.get("RW", True)},
                    }
                    for m in (obj.get("Mounts") or [])
                ],
                # Docker has no per-container egress allowlist locally.
                "network": {
                    "enabled": True,
                    "policy": {"default_egress": "allow", "default_ingress": "allow", "rules": []},
                },
            }
        }

    async def logs(self, handle: str, *, tail: int | None = None, since: str | None = None) -> str:
        argv = [self._docker, "logs", "--timestamps"]
        if tail is not None:
            argv += ["--tail", str(tail)]
        if since:
            argv += ["--since", since]
        argv.append(handle)
        rc, out, err = await self._run(argv)
        if rc != 0:
            raise RuntimeUnavailable(f"`docker logs {handle}` failed: {err.strip() or out.strip()}")
        return out + err  # docker splits stdout/stderr; OpenClaw logs to stderr

    async def read_status(self, handle: str) -> dict | None:
        # Reads the host side of the bind mount — no container interaction.
        return read_status_file(self._status_host_dir(handle))

    async def used_host_ports(self) -> set[int]:
        # Every running container (not only Reef's) — any of them holding a host
        # port would make `docker run -p <that port>` fail to bind. Best-effort.
        rc, out, _ = await self._run([self._docker, "ps", "--format", "{{json .}}"])
        if rc != 0:
            return set()
        used: set[int] = set()
        for d in _iter_json_lines(out):
            used |= _host_ports(str(d.get("Ports", "")))
        return used

    # ── ImageRuntime ── (dev: build with docker, no msb load) ──
    async def list_images(self) -> list[ImageInfo]:
        return await list_local_images(docker_bin=self._docker, runner=self._run)

    def build_image(self, spec: BuildImageSpec):
        return build_image_stream(spec, docker_bin=self._docker, msb_bin="msb", msb_load=False)

    async def activate_image(self, tag: str) -> None:
        await activate_image(
            tag, docker_bin=self._docker, msb_bin="msb", msb_load=False, runner=self._run
        )

    async def image_env(self, image: str) -> dict[str, str]:
        return await _image_env(image, docker_bin=self._docker, runner=self._run)
