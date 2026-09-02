"""Latest-version lookup + semver compare — the version logic the SERVER owns.

For each runtime, two "latest" floors power the dashboard's "update available"
hints (and, joined with the active image's baked versions, the server-computed
``build_available`` — see ``fleet.FleetService.image_status``):

  • **openclaw** — runtime engine version from the public npm ``openclaw``
    package (``/latest``), then NORMALIZED against ghcr: the build's engine is the
    ``ghcr.io/openclaw/openclaw:<tag>`` BASE IMAGE (the CLI ships preinstalled —
    npm is only the release-version oracle), and upstream's npm-only respins
    (``X.Y.Z-N``) never get an image tag, so the raw npm string can be unbuildable.
    The floor we advertise is the first of ``[npm version, its X.Y.Z base]`` that
    actually exists on ghcr — it prefills the build dialog, so it must be pullable.
    clawbits **plugin pair** from the public ClawHub registry. The channel package
    (``GET /api/v1/packages/clawbits-openclaw-plugin`` → ``package.latestVersion``)
    is the release oracle; the image build installs the companion at that exact
    version and rejects a missing/mismatched pair. A baked version behind a floor
    ⇒ a rebuild is worth it. (Newest published, NOT compatibility-filtered:
    "Build latest" pairs it with the newest engine.)
  • **ironclaw** — the engine is built locally from the ironclaw checkout (no
    external "latest"), and the clawbits **channel** ships from this tree, so
    IronClaw has no actionable external floor yet (both null). It gains one once
    the channel is published to a registry.
  • **hermes** — same shape as IronClaw: the engine comes from a locally built
    base image (``HERMES_BASE_IMAGE``) and the clawbits **platform plugin** ships
    from this tree (``extensions/hermes``), so both floors are null. Note this is
    the in-tree plugin, NOT the ClawHub-published ``clawbits-openclaw-plugin`` —
    they are different artifacts, so OpenClaw's plugin floor must not be reused
    here (it would fabricate a bogus "update available").

Both lookups hit PUBLIC registries (npm, ClawHub) — no clawbits-server pairing is
needed, so the checks stay standalone by default.

Optional + best-effort by design:
  • ``REEF_VERSION_CHECK=0`` disables all outbound checks (``enabled=false``).
  • Results are cached in-process for ``REEF_VERSION_CHECK_TTL`` seconds; a failed
    refresh serves the last-good value (never poisons the cache with null).
  • Nothing here ever raises into the request path.
"""

from __future__ import annotations

import os
import re
import time
from datetime import UTC, datetime

import httpx

_NPM_OPENCLAW = "https://registry.npmjs.org/openclaw/latest"
# ghcr, where the openclaw Dockerfile's FROM pulls its base image. Anonymous
# pull-scope token + a manifest HEAD is how we ask "does this tag exist?".
_GHCR_TOKEN_URL = "https://ghcr.io/token?scope=repository:openclaw/openclaw:pull"
_GHCR_MANIFEST_URL = "https://ghcr.io/v2/openclaw/openclaw/manifests/{tag}"
# Multi-arch releases publish an index/manifest-list; accept single manifests too.
_GHCR_MANIFEST_ACCEPT = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)
# ClawHub channel metadata carries ``package.latestVersion``. The release workflow
# publishes/verifies the companion first, and build.sh installs that companion at
# the channel's exact resolved version.
_CLAWHUB_PLUGIN = "https://clawhub.ai/api/v1/packages/clawbits-openclaw-plugin"
_HTTP_TIMEOUT = 5.0

# key -> (value, monotonic_at). Only *successful* fetches are cached, so a
# transient registry outage can't pin a null for the whole TTL.
_cache: dict[str, tuple[str, float]] = {}


def compare_versions(a: str, b: str) -> int:
    """Numeric-segment semver compare (split on ``.`` ``+`` ``-``). Returns -1/0/1.
    Any NON-numeric segment ⇒ 0 (treated equal), so a parse quirk never fabricates
    an "outdated" — this mirrors the frontend's ``compareVersions`` exactly, and is
    the single comparison the server owns so clients don't re-implement semver."""
    pa = re.split(r"[.+-]", a)
    pb = re.split(r"[.+-]", b)
    for i in range(max(len(pa), len(pb))):
        sa = pa[i] if i < len(pa) else "0"
        sb = pb[i] if i < len(pb) else "0"
        if not sa.isdigit() or not sb.isdigit():
            return 0
        na, nb = int(sa), int(sb)
        if na != nb:
            return -1 if na < nb else 1
    return 0


def is_outdated(running: str | None, latest: str | None) -> bool:
    """True when ``running`` is strictly behind ``latest`` (both present)."""
    if not running or not latest:
        return False
    return compare_versions(running, latest) < 0


def _ttl_seconds() -> int:
    try:
        return max(0, int(os.getenv("REEF_VERSION_CHECK_TTL", "10800")))  # default 3h
    except ValueError:
        return 10800


def _enabled() -> bool:
    return os.getenv("REEF_VERSION_CHECK", "1").strip().lower() not in {"0", "false", "off", "no"}


def _now() -> float:
    return time.monotonic()


def _image_tag_candidates(version: str) -> list[str]:
    """The ghcr tags an npm version may correspond to, best first: the version
    itself, then its numeric ``X.Y.Z`` base when it carries a suffix. Covers the
    npm-only respin scheme (``2026.7.1-2`` ⇒ image ``2026.7.1``); prereleases that
    DO ship images (``2026.7.1-beta.2``) match on the first candidate anyway."""
    candidates = [version]
    m = re.match(r"^(\d+\.\d+\.\d+)[-+]", version)
    if m:
        candidates.append(m.group(1))
    return candidates


async def _ghcr_tag_exists(client: httpx.AsyncClient, token: str, tag: str) -> bool | None:
    """Whether ``ghcr.io/openclaw/openclaw:<tag>`` exists. ``None`` = indeterminate
    (network hiccup / unexpected status) — never treated as existence."""
    try:
        resp = await client.head(
            _GHCR_MANIFEST_URL.format(tag=tag),
            headers={"Authorization": f"Bearer {token}", "Accept": _GHCR_MANIFEST_ACCEPT},
        )
    except Exception:
        return None
    if resp.status_code == 200:
        return True
    if resp.status_code == 404:
        return False
    return None


async def _resolve_openclaw_image_tag(client: httpx.AsyncClient, version: str) -> str | None:
    """Map npm's latest onto a ghcr tag a build can actually pull. ghcr fully
    unreachable (no token) ⇒ return the npm value unvalidated (best-effort, the
    pre-validation behavior). ghcr reachable but no candidate exists ⇒ ``None``,
    so ``_resolve`` serves the last-good floor instead of an unbuildable one —
    e.g. npm publishes before the image lands, or an npm-only respin."""
    try:
        resp = await client.get(_GHCR_TOKEN_URL)
        resp.raise_for_status()
        token = resp.json().get("token")
    except Exception:
        token = None
    if not isinstance(token, str) or not token:
        return version
    for tag in _image_tag_candidates(version):
        if await _ghcr_tag_exists(client, token, tag):
            return tag
    return None


async def _openclaw_latest() -> str | None:
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.get(_NPM_OPENCLAW)
            resp.raise_for_status()
            value = resp.json().get("version")
            if not (isinstance(value, str) and value):
                return None
            return await _resolve_openclaw_image_tag(client, value)
    except Exception:
        return None


async def _clawhub_plugin_latest() -> str | None:
    """Newest published clawbits channel on the public ClawHub registry.

    build.sh uses this release version for the matching companion too. Public (no
    auth); a failed or unexpected response yields ``None`` (→ last-good cache or
    null)."""
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.get(_CLAWHUB_PLUGIN)
            resp.raise_for_status()
            pkg = resp.json().get("package") or {}
            value = pkg.get("latestVersion")
            return value if isinstance(value, str) and value else None
    except Exception:
        return None


async def _resolve(key: str, fetch) -> str | None:
    """Cache-first resolve. Serves a fresh cache hit, otherwise fetches; on a
    failed fetch (``None``) keeps the last-good value rather than caching null."""
    hit = _cache.get(key)
    if hit is not None and (_now() - hit[1]) < _ttl_seconds():
        return hit[0]
    value = await fetch()
    if value is not None:
        _cache[key] = (value, _now())
        return value
    return hit[0] if hit is not None else None


def _component(latest: str | None, source: str) -> dict:
    return {"latest": latest, "source": source if latest else None}


async def latest_versions() -> dict:
    """Latest available versions per runtime for the dashboard. Always returns a
    payload (best-effort). Shape::

        {enabled, fetched_at,
         openclaw: {runtime: {latest, source}, component: {latest, source}},
         ironclaw: {runtime: {latest, source}, component: {latest, source}},
         hermes:   {runtime: {latest, source}, component: {latest, source}}}

    IronClaw's engine is self-built and its channel ships from this tree; Hermes'
    engine comes from a local base image and its plugin ships from this tree — so
    both runtimes' floors are null (no external "latest" to be behind) until those
    artifacts are published to a registry."""
    ironclaw = {
        "runtime": _component(None, "self-built"),
        "component": _component(None, "clawhub"),
    }
    # In-tree, not published: the clawbits-platform plugin has no registry floor.
    hermes = {
        "runtime": _component(None, "base-image"),
        "component": _component(None, "in-tree"),
    }
    if not _enabled():
        return {
            "enabled": False,
            "fetched_at": None,
            "openclaw": {
                "runtime": _component(None, "npm"),
                "component": _component(None, "clawhub"),
            },
            "ironclaw": ironclaw,
            "hermes": hermes,
        }
    openclaw_runtime = await _resolve("openclaw", _openclaw_latest)
    plugin = await _resolve("clawhub_plugin", _clawhub_plugin_latest)
    return {
        "enabled": True,
        "fetched_at": datetime.now(UTC).isoformat(),
        "openclaw": {
            "runtime": _component(openclaw_runtime, "npm"),
            "component": _component(plugin, "clawhub"),
        },
        "ironclaw": ironclaw,
        "hermes": hermes,
    }
