"""Local agent-image inventory + build — the dashboard's Images section.

Two facts shape this module:

- **Docker is the builder on every host.** Even when the RUNTIME is microsandbox,
  the prod box installs Docker to *build* the image (then ``docker save | msb
  image load`` copies it into the msb store — see ``build.sh`` / ``install.sh``).
  So the agent images always exist in Docker, and listing reads ``docker image
  inspect`` uniformly on both backends — no reliance on an ``msb image list`` that
  doesn't exist.
- **``build.sh`` is the single source of truth for a build.** It probes the built
  image for the REAL versions that landed and stamps a truthful, self-describing
  immutable tag (``reef-oc:oc<openclaw>-pl<plugin>`` / ``reef-ic:ic<ironclaw>-ch<channel>``
  / ``reef-hm:hm<hermes>-pl<plugin>``) plus the floating active tag
  (``reef-oc:plugin`` / ``reef-ic:channel`` / ``reef-hm:plugin``) that new agents
  boot — so a successful build *auto-promotes*. We stream it rather than
  re-implement ``docker build`` in Python.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from reef._subprocess import Runner, _default_runner
from reef.errors import RuntimeUnavailable

# The OpenClaw image repo; build.sh tags reef-oc:plugin + the reef-oc:oc…-pl… stack.
IMAGE_REPO = "reef-oc"

# The OCI label every runtime bakes for the derived image (stack) version.
_LABEL_REEF_VERSION = "org.opencontainers.image.version"


@dataclass(frozen=True, slots=True)
class _RepoCfg:
    """How one agent type's images are named + labelled."""

    repo: str  # docker repo (reef-oc / reef-ic)
    env: str  # env override for the floating "active" tag
    default: str  # default floating tag (what a new agent of this type boots)
    runtime_label: str  # OCI label carrying the runtime engine version (openclaw/ironclaw)
    component_label: str  # OCI label carrying the clawbits component version (plugin/channel)


# Per-agent-type image config. build.sh tags each image under its repo; the
# floating "active" tag is what a new agent of that type boots (and a rebuild
# re-points). ``active_tag`` / ``list_local_images`` / create-image validation /
# activate all read from this one table, so it stays the single place agent types
# and their labels are wired. OpenClaw bakes org.reef.openclaw.version +
# org.reef.clawbits-plugin.version; IronClaw bakes the ironclaw/channel pair;
# Hermes bakes its engine version + the same clawbits-plugin label (it carries the
# clawbits-platform plugin, not a channel).
_AGENT_IMAGE_REPOS: dict[str, _RepoCfg] = {
    "openclaw": _RepoCfg(
        IMAGE_REPO,
        "REEF_OPENCLAW_IMAGE",
        f"{IMAGE_REPO}:plugin",
        "org.reef.openclaw.version",
        "org.reef.clawbits-plugin.version",
    ),
    "ironclaw": _RepoCfg(
        "reef-ic",
        "REEF_IRONCLAW_IMAGE",
        "reef-ic:channel",
        "org.reef.ironclaw.version",
        "org.reef.clawbits-channel.version",
    ),
    "hermes": _RepoCfg(
        "reef-hm",
        "REEF_HERMES_IMAGE",
        "reef-hm:plugin",
        "org.reef.hermes.version",
        "org.reef.clawbits-plugin.version",
    ),
}


@dataclass(frozen=True, slots=True)
class ImageInfo:
    """One agent image tag, as the dashboard's Images list shows it.

    ``runtime_version`` / ``component_version`` are generic across runtimes: the
    openclaw engine + clawbits plugin for OpenClaw, the ironclaw engine + clawbits
    channel for IronClaw, the hermes engine + clawbits plugin for Hermes. Both null
    on images built before their labels existed.
    """

    tag: str  # e.g. "reef-oc:plugin" or "reef-oc:oc2026.6.10-pl0.8.1"
    image_id: str  # full sha256:… digest
    created_at: datetime | None
    size_bytes: int
    reef_image_version: str | None  # derived stack string (org.opencontainers.image.version)
    runtime_version: str | None  # openclaw | ironclaw | hermes engine version (baked LABEL)
    component_version: str | None  # clawbits plugin | channel version (baked LABEL)
    is_active: bool  # this tag (or its image) is the one new agents boot
    agent_type: str = "openclaw"  # openclaw | ironclaw | hermes (which runtime this image is)


@dataclass(frozen=True, slots=True)
class BuildImageSpec:
    """A request to build a fresh agent image via build.sh."""

    agent_type: str = "openclaw"  # which runtime to build (selects the build.sh)
    # Engine base-tag override (OpenClaw only); None ⇒ the Dockerfile default.
    runtime_version: str | None = None
    # clawbits plugin pin (OpenClaw only): a pinned value gives a deterministic,
    # cacheable build; None ⇒ build.sh re-resolves the latest plugin each build.
    component_version: str | None = None
    # False (default) ⇒ smart cache: base layers cached, plugin/channel always
    # re-resolved. True ⇒ full --no-cache clean rebuild.
    force_fresh: bool = False


def active_tag(agent_type: str = "openclaw") -> str:
    """The floating tag new agents of ``agent_type`` boot (and a build re-points).
    Defaults to OpenClaw so existing no-arg callers are unchanged."""
    cfg = _AGENT_IMAGE_REPOS.get(agent_type, _AGENT_IMAGE_REPOS["openclaw"])
    return os.getenv(cfg.env, cfg.default)


def _agent_type_for_tag(tag: str) -> str:
    """Which agent type a tag belongs to, by its repo prefix (``reef-ic:…`` ⇒
    ironclaw). Unknown prefixes default to openclaw (back-compat)."""
    repo = tag.split(":", 1)[0]
    for agent_type, cfg in _AGENT_IMAGE_REPOS.items():
        if cfg.repo == repo:
            return agent_type
    return "openclaw"


def _build_sh(agent_type: str = "openclaw") -> Path:
    """The build script for a runtime: ``images/<agent_type>-runtime/build.sh``.
    An unregistered type falls back to OpenClaw (same back-compat rule as
    ``active_tag``), so a bogus ``agent_type`` can never point the builder at an
    arbitrary path."""
    known = agent_type if agent_type in _AGENT_IMAGE_REPOS else "openclaw"
    return Path(__file__).resolve().parent / "images" / f"{known}-runtime" / "build.sh"


def _parse_created(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


async def list_local_images(*, docker_bin: str, runner: Runner | None = None) -> list[ImageInfo]:
    """Every reef agent image Docker knows — ``reef-oc:*`` (OpenClaw), ``reef-ic:*``
    (IronClaw) and ``reef-hm:*`` (Hermes), newest first across all of them. One row
    per tag; a tag sharing its agent type's active-image digest is flagged
    ``is_active``."""
    run = runner or _default_runner
    collected: list[tuple[datetime | None, ImageInfo]] = []
    for agent_type, cfg in _AGENT_IMAGE_REPOS.items():
        collected.extend(await _list_repo_images(agent_type, cfg, docker_bin=docker_bin, runner=run))
    # Newest first across all repos; tags with no timestamp sort last.
    collected.sort(key=lambda c: (c[0] is not None, c[0]), reverse=True)
    return [info for _, info in collected]


async def _list_repo_images(
    agent_type: str, cfg: _RepoCfg, *, docker_bin: str, runner: Runner
) -> list[tuple[datetime | None, ImageInfo]]:
    """Images under one repo, tagged with ``agent_type``. An absent repo (this
    agent type was never built here) yields ``[]`` — docker returns an empty list,
    not an error."""
    rc, out, _ = await runner([docker_bin, "images", cfg.repo, "-q", "--no-trunc"])
    if rc != 0:
        raise RuntimeUnavailable(f"`docker images {cfg.repo}` failed (rc={rc})")
    ids = sorted({line.strip() for line in out.splitlines() if line.strip()})
    if not ids:
        return []
    # One inspect over all unique images; tab-delimited so the JSON fields (which
    # never contain raw tabs) parse cleanly.
    fmt = "{{.Id}}\t{{.Created}}\t{{.Size}}\t{{json .RepoTags}}\t{{json .Config.Labels}}"
    rc, out, err = await runner([docker_bin, "image", "inspect", "--format", fmt, *ids])
    if rc != 0:
        raise RuntimeUnavailable(f"`docker image inspect` failed (rc={rc}): {err.strip()}")

    want = active_tag(agent_type)
    active_id: str | None = None
    rows: list[tuple[str, datetime | None, int, list[str], dict]] = []
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 5:
            continue
        image_id, created_s, size_s, repotags_s, labels_s = parts[:5]
        try:
            repo_tags = json.loads(repotags_s) or []
            labels = json.loads(labels_s) or {}
        except json.JSONDecodeError:
            continue
        created = _parse_created(created_s)
        size = int(size_s) if size_s.isdigit() else 0
        rows.append((image_id, created, size, repo_tags, labels))
        if want in repo_tags:
            active_id = image_id

    images: list[tuple[datetime | None, ImageInfo]] = []
    for image_id, created, size, repo_tags, labels in rows:
        for tag in repo_tags:
            if not tag.startswith(f"{cfg.repo}:"):
                continue  # an image can carry foreign tags; only show this repo's
            images.append(
                (
                    created,
                    ImageInfo(
                        tag=tag,
                        image_id=image_id,
                        created_at=created,
                        size_bytes=size,
                        reef_image_version=labels.get(_LABEL_REEF_VERSION),
                        runtime_version=labels.get(cfg.runtime_label),
                        component_version=labels.get(cfg.component_label),
                        is_active=image_id == active_id,
                        agent_type=agent_type,
                    ),
                )
            )
    return images


async def image_env(image: str, *, docker_bin: str, runner: Runner | None = None) -> dict[str, str]:
    """The ENV an image bakes in (``docker image inspect .Config.Env``). Used by the
    upgrade path to subtract image-provided env from a container's full env so only
    REEF-injected vars are replayed onto the new image — otherwise a stale baked
    ``REEF_IMAGE_VERSION`` would ride along and the agent would report the old
    version forever. Best-effort: an unknown image yields ``{}`` (replay nothing
    extra to subtract)."""
    run = runner or _default_runner
    rc, out, _ = await run(
        [docker_bin, "image", "inspect", "--format", "{{json .Config.Env}}", image]
    )
    if rc != 0:
        return {}
    try:
        pairs = json.loads(out.strip().splitlines()[0]) or []
    except (json.JSONDecodeError, IndexError):
        return {}
    env: dict[str, str] = {}
    for item in pairs:
        if isinstance(item, str) and "=" in item:
            k, v = item.split("=", 1)
            env[k] = v
    return env


def _build_env(spec: BuildImageSpec, *, docker_bin: str, msb_bin: str, msb_load: bool) -> dict[str, str]:
    env = dict(os.environ)
    # Empty string ⇒ build.sh's `[ -n "$REEF_NO_CACHE" ]` is false (smart cache).
    env["REEF_NO_CACHE"] = "1" if spec.force_fresh else ""
    env["REEF_DOCKER_BIN"] = docker_bin
    # Version overrides apply only to the OpenClaw build (it takes a base-tag
    # override + a plugin pin as build-args). IronClaw derives its engine/channel
    # from source at build time, and Hermes derives its engine from the base image
    # (HERMES_BASE_IMAGE) and its plugin from this tree — neither takes a pin.
    if spec.agent_type == "openclaw":
        if spec.runtime_version:
            env["OPENCLAW_VERSION"] = spec.runtime_version
        # Sets the plugin-layer cache key AND (via the post-build probe) is only a
        # hint — build.sh re-stamps the truthful installed plugin regardless.
        if spec.component_version:
            env["CLAWBITS_PLUGIN_VERSION"] = spec.component_version
    if msb_load:
        env["REEF_MSB_LOAD"] = "1"
        env["REEF_MSB_BIN"] = msb_bin
    return env


async def build_image_stream(
    spec: BuildImageSpec,
    *,
    docker_bin: str,
    msb_bin: str,
    msb_load: bool,
) -> AsyncIterator[str]:
    """Run the runtime's ``build.sh`` and yield its merged stdout+stderr line-by-line
    for a live build log. It re-points the floating active tag (auto-promote) and
    stamps the truthful stack tag, and (``msb_load``) loads the result into
    microsandbox. Raises ``RuntimeUnavailable`` on a non-zero exit so the job is
    marked failed."""
    build_sh = _build_sh(spec.agent_type)
    if not build_sh.is_file():
        raise RuntimeUnavailable(f"build script missing at {build_sh}")
    argv: list[str] = ["bash", str(build_sh)]
    env = _build_env(spec, docker_bin=docker_bin, msb_bin=msb_bin, msb_load=msb_load)
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,  # merge so the docker-build progress interleaves in order
        env=env,
        cwd=str(build_sh.parent),
    )
    assert proc.stdout is not None
    try:
        async for raw in proc.stdout:
            yield raw.decode(errors="replace").rstrip("\n")
    finally:
        rc = await proc.wait()
    if rc != 0:
        raise RuntimeUnavailable(f"image build failed (rc={rc})")


async def activate_image(
    tag: str,
    *,
    docker_bin: str,
    msb_bin: str,
    msb_load: bool,
    runner: Runner | None = None,
) -> None:
    """Re-point the floating active tag at an existing image (rollback / manual
    promote): ``docker tag <tag> <active-tag>`` (+ reload into msb when the runtime
    is microsandbox). The active tag is resolved from the tag's OWN repo, so
    activating a ``reef-ic:*`` image re-points ``reef-ic:channel`` — never the
    OpenClaw tag. Idempotent."""
    run = runner or _default_runner
    want = active_tag(_agent_type_for_tag(tag))
    rc, _, err = await run([docker_bin, "tag", tag, want])
    if rc != 0:
        raise RuntimeUnavailable(f"`docker tag {tag} {want}` failed (rc={rc}): {err.strip()}")
    if msb_load:
        # docker save <tag> | msb image load -t <active>  — same dance as build.sh.
        save = await asyncio.create_subprocess_exec(
            docker_bin, "save", want, stdout=asyncio.subprocess.PIPE
        )
        load = await asyncio.create_subprocess_exec(
            msb_bin,
            "image",
            "load",
            "-t",
            want,
            stdin=save.stdout,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        if save.stdout is not None:
            save.stdout.close()  # let `docker save` get SIGPIPE if `msb` dies
        _, load_err = await load.communicate()
        await save.wait()
        if load.returncode:
            raise RuntimeUnavailable(
                f"`msb image load` failed (rc={load.returncode}): {load_err.decode().strip()}"
            )
