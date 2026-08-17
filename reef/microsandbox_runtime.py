"""``AgentRuntime`` + ``FleetRuntime`` backed by the ``msb`` CLI (microsandbox),
driven via subprocess — the same pattern as clawbits' ``git/repo_manager.py``.

The CLI is the full surface and validated on the M1 Pro: ``create`` boots a
named sandbox in the background, ``start``/``stop`` restart it with state
preserved (named volume), ``remove`` destroys it, and ``status --format json``
reports state. The read family (``list``/``metrics``/``inspect``/``logs``) backs
the admin/fleet API. microsandbox is embedded — no daemon — so this runs
wherever Reef runs (the agent host).

Egress: when ``spec.net_allow`` is non-empty, Reef pins a per-sandbox allowlist
natively (``--net-default-egress deny`` + ``--net-rule allow@<target>``). Empty
(the MVP default) leaves microsandbox's default outbound behavior intact.
"""

import json
import os
import shutil
from collections.abc import Sequence
from datetime import datetime

from reef._subprocess import Runner, _default_runner, _redact
from reef.errors import RuntimeUnavailable
from reef.guest_env import EnvRecord, ensure_env_dir, read_env_file, write_env_file
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

_STATUS_MAP = {
    "running": SandboxState.RUNNING,
    "stopped": SandboxState.STOPPED,
    "failed": SandboxState.FAILED,
}


def _parse_dt(value: object) -> datetime | None:
    """Parse an ISO-8601 timestamp from ``msb`` output; tolerate junk."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _msb_cpus(value: float) -> str:
    """msb accepts whole-number CPU counts ("2"), not Docker-style floats ("2.0")."""
    if not float(value).is_integer():
        raise RuntimeUnavailable(f"microsandbox requires whole-number CPUs; got {value!r}")
    return str(int(value))


def _metrics_from(d: dict) -> MetricsSample:
    return MetricsSample(
        name=str(d.get("name", "")),
        cpu_percent=float(d.get("cpu_percent", 0.0)),
        memory_bytes=int(d.get("memory_bytes", 0)),
        memory_limit_bytes=int(d.get("memory_limit_bytes", 0)),
        disk_read_bytes=int(d.get("disk_read_bytes", 0)),
        disk_write_bytes=int(d.get("disk_write_bytes", 0)),
        net_rx_bytes=int(d.get("net_rx_bytes", 0)),
        net_tx_bytes=int(d.get("net_tx_bytes", 0)),
        uptime_secs=float(d.get("uptime_secs", 0.0)),
    )


class MicrosandboxRuntime:
    def __init__(
        self,
        *,
        msb_bin: str | None = None,
        runner: Runner | None = None,
        volumes_dir: str | None = None,
        state_dir: str | None = None,
    ) -> None:
        self._msb = msb_bin or os.getenv("REEF_MSB_BIN") or shutil.which("msb") or "msb"
        # Docker is the image BUILDER even on an msb host (build.sh `docker build`
        # then `docker save | msb image load`), so image listing/building shells to
        # docker; only running uses msb.
        self._docker = os.getenv("REEF_DOCKER_BIN") or shutil.which("docker") or "docker"
        self._run = runner or _default_runner
        # msb named volumes are host dirs under here; Reef reads the per-agent
        # status volume (reef-status-<id>) host-side. NB: the guest must be able to
        # WRITE it for status.json to appear — see docs/REEF.md §11.2 (volume
        # perms). The read path is correct now; the write is prod-pending.
        self._vol_dir = (
            volumes_dir
            or os.getenv("REEF_MSB_VOLUMES_DIR")
            or os.path.expanduser("~/.microsandbox/volumes")
        )
        # The user-env overlay lives here and not in an msb named volume: the
        # volumes root above is world-traversable 0755, <state_dir> is 0750.
        self._state_dir = state_dir or os.getenv("REEF_STATE_DIR") or os.path.expanduser("~/.reef")
        self._sandboxes_dir = os.getenv("REEF_MSB_SANDBOXES_DIR") or os.path.join(
            os.path.dirname(self._vol_dir), "sandboxes"
        )

    @staticmethod
    def _status_volume(handle: str) -> str:
        return f"reef-status-{handle}"

    def _env_host_dir(self, handle: str) -> str:
        """Reef owns this outright, so it survives the destroy+create of an in-place
        upgrade (``msb remove`` never sees it)."""
        return os.path.join(self._state_dir, "env", handle)

    async def _call(self, *args: str) -> str:
        rc, out, err = await self._run([self._msb, *args])
        if rc != 0:
            detail = err.strip() or out.strip()
            raise RuntimeUnavailable(f"`msb {_redact(args)}` failed (rc={rc}): {detail}")
        return out

    async def _ensure_volume(self, name: str) -> None:
        rc, out, err = await self._run([self._msb, "volume", "create", name])
        if rc != 0 and "exist" not in (err + out).lower():
            raise RuntimeUnavailable(
                f"`msb volume create {name}` failed: {err.strip() or out.strip()}"
            )

    async def create(self, spec: SandboxSpec) -> str:
        cpus = _msb_cpus(spec.limits.cpus)
        await self._ensure_volume(spec.volume)
        argv: list[str] = [
            "create",
            "-n",
            spec.sandbox_id,
            "-c",
            cpus,
            "-m",
            f"{spec.limits.memory_mb}M",
            "-v",
            f"{spec.volume}:{spec.volume_dest}",
            "--replace",
        ]
        for extra_name, extra_dest in spec.extra_volumes:
            await self._ensure_volume(extra_name)
            argv += ["-v", f"{extra_name}:{extra_dest}"]
        if spec.init:
            argv += ["--init", spec.init]
        if spec.status_dest:
            status_vol = self._status_volume(spec.sandbox_id)
            await self._ensure_volume(status_vol)
            argv += ["-v", f"{status_vol}:{spec.status_dest}"]
        if spec.env_dest:
            # Read-only: the agent must not be able to rewrite its own environ.
            env_dir = self._env_host_dir(spec.sandbox_id)
            ensure_env_dir(env_dir)
            argv += ["-v", f"{env_dir}:{spec.env_dest}:ro"]
        for key, value in spec.env.items():
            argv += ["-e", f"{key}={value}"]
        if spec.net_allow:
            argv += ["--net-default-egress", "deny"]
            for target in spec.net_allow:
                argv += ["--net-rule", f"allow@{target}"]
        for forward in spec.ports:
            argv += ["-p", forward]
        argv.append(spec.image)
        await self._call(*argv)
        return spec.sandbox_id  # the sandbox name is the handle

    async def start(self, handle: str) -> None:
        if await self.status(handle) is SandboxState.RUNNING:
            return
        await self._call("start", handle)

    async def stop(self, handle: str) -> None:
        if await self.status(handle) is SandboxState.STOPPED:
            return
        await self._call("stop", handle)

    async def destroy(self, handle: str) -> None:
        rc, out, err = await self._run([self._msb, "remove", "-f", handle])
        if rc != 0 and "not found" not in (err + out).lower():
            raise RuntimeUnavailable(f"`msb remove {handle}` failed: {err.strip() or out.strip()}")

    async def status(self, handle: str) -> SandboxState:
        rc, out, _ = await self._run([self._msb, "status", handle, "--format", "json"])
        if rc != 0:
            return SandboxState.DESTROYED  # not found / gone
        try:
            data = json.loads(out)
        except json.JSONDecodeError:
            return SandboxState.FAILED
        # `status <name>` may return the object directly or a single-element list.
        if isinstance(data, list):
            data = next((d for d in data if d.get("name") == handle), data[0] if data else {})
        return _STATUS_MAP.get(str(data.get("status", "")).lower(), SandboxState.FAILED)

    # ── Fleet / observability (admin API) ──────────────────────────────────

    async def list_sandboxes(self) -> list[SandboxInfo]:
        out = await self._call("list", "--format", "json")
        data = json.loads(out or "[]")
        return [
            SandboxInfo(
                name=str(d.get("name", "")),
                image=str(d.get("image", "")),
                state=_STATUS_MAP.get(str(d.get("status", "")).lower(), SandboxState.FAILED),
                created_at=_parse_dt(d.get("created_at")),
            )
            for d in data
        ]

    async def metrics(self) -> list[MetricsSample]:
        # Best-effort: an empty/idle host or a flaky metrics read shouldn't break
        # the fleet listing, so swallow failures and return what we can.
        rc, out, _ = await self._run([self._msb, "metrics", "--format", "json"])
        if rc != 0 or not out.strip():
            return []
        try:
            data = json.loads(out)
        except json.JSONDecodeError:
            return []
        return [_metrics_from(d) for d in data] if isinstance(data, list) else []

    async def metrics_for(self, handle: str) -> MetricsSample | None:
        rc, out, _ = await self._run([self._msb, "metrics", handle, "--format", "json"])
        if rc != 0 or not out.strip():
            return None
        try:
            data = json.loads(out)
        except json.JSONDecodeError:
            return None
        if isinstance(data, list):
            data = next((d for d in data if d.get("name") == handle), None)
        return _metrics_from(data) if data else None

    async def inspect(self, handle: str) -> dict:
        out = await self._call("inspect", handle, "--format", "json")
        try:
            return json.loads(out)
        except json.JSONDecodeError as e:
            raise RuntimeUnavailable(f"`msb inspect {handle}` returned non-JSON") from e

    async def logs(self, handle: str, *, tail: int | None = None, since: str | None = None) -> str:
        argv = ["logs", handle, "--timestamps"]
        if tail is not None:
            argv += ["--tail", str(tail)]
        if since:
            argv += ["--since", since]
        out = await self._call(*argv)
        if out.strip():
            return out
        # `msb create --init ...` writes the init process' stdout/stderr to the
        # sandbox kernel log, while `msb logs` can show only the tiny exec log.
        # Reef runs OpenClaw through --init, so surface that file as a fallback.
        return self._kernel_log(handle, tail=tail)

    def _kernel_log(self, handle: str, *, tail: int | None = None) -> str:
        path = os.path.join(self._sandboxes_dir, handle, "logs", "kernel.log")
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                lines = f.read().splitlines()
        except OSError:
            return ""
        if tail is not None:
            lines = lines[-tail:]
        return "\n".join(lines) + ("\n" if lines else "")

    async def read_status(self, handle: str) -> dict | None:
        # Host-side read of the status volume's dir — no guest interaction.
        return read_status_file(os.path.join(self._vol_dir, self._status_volume(handle)))

    async def read_guest_env(self, handle: str) -> list[EnvRecord] | None:
        return read_env_file(self._env_host_dir(handle))

    async def write_guest_env(self, handle: str, records: Sequence[EnvRecord]) -> None:
        write_env_file(self._env_host_dir(handle), records)

    async def remove_guest_env(self, handle: str) -> None:
        shutil.rmtree(self._env_host_dir(handle), ignore_errors=True)

    async def used_host_ports(self) -> set[int]:
        # TODO(prod): parse `-p` host ports from `msb inspect` once its port shape is
        # validated (`msb list` carries none). Empty for now → port-reconcile relies
        # on Reef's store; a real collision still fails loudly at `msb create -p`
        # rather than corrupting state. See docs/REEF.md §9.
        return set()

    # ── ImageRuntime ── (prod: build with docker, then load into msb) ──
    async def list_images(self) -> list[ImageInfo]:
        return await list_local_images(docker_bin=self._docker, runner=self._run)

    def build_image(self, spec: BuildImageSpec):
        return build_image_stream(spec, docker_bin=self._docker, msb_bin=self._msb, msb_load=True)

    async def activate_image(self, tag: str) -> None:
        await activate_image(
            tag, docker_bin=self._docker, msb_bin=self._msb, msb_load=True, runner=self._run
        )

    async def image_env(self, image: str) -> dict[str, str]:
        return await _image_env(image, docker_bin=self._docker, runner=self._run)
