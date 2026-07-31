"""Agent-image management: docker-output parsing (``image_ops``), the in-process
build-job manager (``build_jobs``), and the ``/images`` API.

Async bits run via ``asyncio.run`` so no pytest-asyncio dependency is needed.
"""

from __future__ import annotations

import asyncio
import json
import time

import pytest
from fastapi.testclient import TestClient

from reef.api.app import create_app
from reef.build_jobs import BuildJobManager
from reef.errors import BuildInProgress
from reef.fleet import FleetService
from reef.image_ops import BuildImageSpec, ImageInfo, _build_env, list_local_images
from reef.store import InMemorySandboxStore
from reef.tests.fakes import FakeAdminRuntime


# ── image_ops.list_local_images parsing ───────────────────────────────────────
def _fake_docker(images_out: str, inspect_out: str, rc: int = 0):
    async def run(argv):
        if "images" in argv:
            return (rc, images_out, "")
        if "inspect" in argv:
            return (rc, inspect_out, "")
        return (0, "", "")

    return run


def _inspect_line(image_id, created, size, repo_tags, labels):
    return "\t".join([image_id, created, str(size), json.dumps(repo_tags), json.dumps(labels)])


def test_list_local_images_parses_tags_labels_and_active():
    ids = "sha256:aaa\nsha256:aaa\nsha256:bbb\n"  # plugin+0.6.1 share aaa (dedupe)
    inspect = "\n".join(
        [
            _inspect_line(
                "sha256:aaa",
                "2026-06-22T15:23:43.7Z",
                1067589514,
                ["reef-oc:0.6.1", "reef-oc:plugin"],
                {
                    "org.opencontainers.image.version": "0.6.1",
                    "org.reef.openclaw.version": "2026.6.9",
                    "org.reef.clawbits-plugin.version": "1.2.3",
                },
            ),
            _inspect_line(
                "sha256:bbb",
                "2026-06-01T00:00:00Z",
                999,
                ["reef-oc:0.5.0"],
                {},  # an older image with no reef labels → None fields
            ),
        ]
    )
    imgs = asyncio.run(list_local_images(docker_bin="docker", runner=_fake_docker(ids, inspect)))
    by_tag = {i.tag: i for i in imgs}
    assert set(by_tag) == {"reef-oc:0.6.1", "reef-oc:plugin", "reef-oc:0.5.0"}
    # Both tags on the active image's digest are flagged active.
    assert by_tag["reef-oc:plugin"].is_active and by_tag["reef-oc:0.6.1"].is_active
    assert by_tag["reef-oc:0.5.0"].is_active is False
    assert by_tag["reef-oc:plugin"].runtime_version == "2026.6.9"
    assert by_tag["reef-oc:plugin"].component_version == "1.2.3"
    assert by_tag["reef-oc:plugin"].reef_image_version == "0.6.1"
    assert by_tag["reef-oc:0.5.0"].runtime_version is None  # tolerate pre-label images
    # Newest first.
    assert imgs[0].created_at >= imgs[-1].created_at


def test_list_local_images_empty():
    assert asyncio.run(list_local_images(docker_bin="docker", runner=_fake_docker("", ""))) == []


def test_list_local_images_ignores_foreign_tags():
    inspect = _inspect_line("sha256:aaa", "2026-06-22T00:00:00Z", 1, ["reef-oc:plugin", "other:latest"], {})
    imgs = asyncio.run(list_local_images(docker_bin="docker", runner=_fake_docker("sha256:aaa\n", inspect)))
    assert [i.tag for i in imgs] == ["reef-oc:plugin"]


def _fake_docker_repos(repo_ids: dict[str, str], inspect_out: str):
    """Runner returning a different id set per ``docker images <repo>`` call and a
    shared inspect blob (each repo pass filters the blob to its own tags)."""

    async def run(argv):
        if "images" in argv:
            repo = argv[argv.index("images") + 1]
            return (0, repo_ids.get(repo, ""), "")
        return (0, inspect_out, "")

    return run


def test_list_local_images_tags_agent_type_across_repos():
    # reef-oc:* ⇒ openclaw, reef-ic:* ⇒ ironclaw; each repo's floating tag is
    # active for ITS OWN type (reef-oc:plugin / reef-ic:channel).
    inspect = "\n".join(
        [
            _inspect_line(
                "sha256:oc", "2026-06-22T00:00:00Z", 1, ["reef-oc:plugin"],
                {"org.reef.openclaw.version": "2026.6.9"},
            ),
            _inspect_line(
                "sha256:ic", "2026-06-23T00:00:00Z", 1, ["reef-ic:channel"],
                {"org.opencontainers.image.version": "0.2.3"},
            ),
        ]
    )
    runner = _fake_docker_repos({"reef-oc": "sha256:oc\n", "reef-ic": "sha256:ic\n"}, inspect)
    by_tag = {i.tag: i for i in asyncio.run(list_local_images(docker_bin="docker", runner=runner))}
    assert by_tag["reef-oc:plugin"].agent_type == "openclaw"
    assert by_tag["reef-ic:channel"].agent_type == "ironclaw"
    assert by_tag["reef-oc:plugin"].is_active
    assert by_tag["reef-ic:channel"].is_active


# ── BuildJobManager ───────────────────────────────────────────────────────────
async def _drain(job, timeout=5.0):
    deadline = time.monotonic() + timeout
    while job.status == "running" and time.monotonic() < deadline:
        await asyncio.sleep(0.005)


def test_build_job_succeeds_and_captures_log():
    async def scenario():
        rt = FakeAdminRuntime()
        rt.build_log = ["pulling…", "built"]
        mgr = BuildJobManager(rt)
        job = await mgr.start(BuildImageSpec(runtime_version="2026.7.0"))
        await _drain(job)
        assert job.status == "succeeded"
        assert list(job.lines) == ["pulling…", "built"]
        assert rt.builds[0].runtime_version == "2026.7.0"
        # A successful fake build "promotes" a new active image row.
        assert (await mgr._runtime.list_images())[0].is_active

    asyncio.run(scenario())


def test_build_job_failure_records_error():
    async def scenario():
        rt = FakeAdminRuntime()
        rt.build_should_fail = True
        mgr = BuildJobManager(rt)
        job = await mgr.start(BuildImageSpec())
        await _drain(job)
        assert job.status == "failed"
        assert job.error

    asyncio.run(scenario())


def test_only_one_build_at_a_time():
    class _Blocking:
        def __init__(self):
            self.release = asyncio.Event()
            self.builds = []

        async def build_image(self, spec):
            self.builds.append(spec)
            yield "start"
            await self.release.wait()
            yield "end"

    async def scenario():
        rt = _Blocking()
        mgr = BuildJobManager(rt)
        job1 = await mgr.start(BuildImageSpec())
        await asyncio.sleep(0.02)  # let it reach the blocking await
        assert mgr.active() is job1
        with pytest.raises(BuildInProgress):
            await mgr.start(BuildImageSpec())
        rt.release.set()
        await _drain(job1)
        assert job1.status == "succeeded"
        # Once finished, a new build is allowed again.
        assert mgr.active() is None

    asyncio.run(scenario())


# ── /images API ───────────────────────────────────────────────────────────────
def _img(tag, active=False, agent_type="openclaw"):
    return ImageInfo(
        tag=tag,
        image_id="sha256:x",
        created_at=None,
        size_bytes=1,
        reef_image_version="0.6.1",
        runtime_version="2026.6.9",
        component_version="1.2.3",
        is_active=active,
        agent_type=agent_type,
    )


def _client(runtime: FakeAdminRuntime | None = None) -> TestClient:
    rt = runtime or FakeAdminRuntime()
    return TestClient(create_app(service=FleetService(rt, InMemorySandboxStore())))


def test_list_images_api():
    rt = FakeAdminRuntime()
    rt.image_list = [_img("reef-oc:plugin", active=True), _img("reef-oc:0.5.0")]
    client = _client(rt)
    r = client.get("/images")
    assert r.status_code == 200
    body = r.json()
    assert [i["tag"] for i in body] == ["reef-oc:plugin", "reef-oc:0.5.0"]
    assert body[0]["is_active"] is True
    assert body[0]["runtime_version"] == "2026.6.9"


def test_list_images_api_exposes_agent_type():
    rt = FakeAdminRuntime()
    rt.image_list = [
        _img("reef-oc:plugin", active=True),
        _img("reef-ic:channel", active=True, agent_type="ironclaw"),
    ]
    body = _client(rt).get("/images").json()
    by_tag = {i["tag"]: i for i in body}
    assert by_tag["reef-oc:plugin"]["agent_type"] == "openclaw"
    assert by_tag["reef-ic:channel"]["agent_type"] == "ironclaw"


def test_build_flow_api():
    rt = FakeAdminRuntime()
    rt.build_log = ["step 1", "step 2"]
    client = _client(rt)
    r = client.post(
        "/images/builds", json={"runtime_version": "2026.7.0", "component_version": "0.7.0"}
    )
    assert r.status_code == 201, r.text
    job_id = r.json()["id"]
    assert r.json()["status"] == "running"
    # Poll until the background build task finishes (runs on the portal loop).
    for _ in range(200):
        jr = client.get(f"/images/builds/{job_id}")
        assert jr.status_code == 200
        if jr.json()["status"] != "running":
            break
        time.sleep(0.02)
    done = jr.json()
    assert done["status"] == "succeeded", done
    assert done["log"] == ["step 1", "step 2"]
    assert done["runtime_version"] == "2026.7.0"
    assert done["component_version"] == "0.7.0"
    # The chosen versions reach build.sh via the spec.
    assert rt.builds[0].runtime_version == "2026.7.0"
    assert rt.builds[0].component_version == "0.7.0"


def test_get_unknown_build_is_404():
    assert _client().get("/images/builds/nope").status_code == 404


# ── _build_env: how a spec becomes build.sh's environment ─────────────────────
def test_build_env_threads_chosen_versions(monkeypatch):
    # Start from a clean slate so the assertions reflect what _build_env adds.
    monkeypatch.delenv("OPENCLAW_VERSION", raising=False)
    monkeypatch.delenv("CLAWBITS_PLUGIN_VERSION", raising=False)
    env = _build_env(
        BuildImageSpec(runtime_version="2026.7.0", component_version="0.7.0"),
        docker_bin="docker",
        msb_bin="msb",
        msb_load=False,
    )
    assert env["OPENCLAW_VERSION"] == "2026.7.0"
    assert env["CLAWBITS_PLUGIN_VERSION"] == "0.7.0"
    # Default = smart cache (base layers cached, plugin re-resolved); NOT no-cache.
    assert env["REEF_NO_CACHE"] == ""


def test_build_env_force_fresh():
    env = _build_env(
        BuildImageSpec(force_fresh=True), docker_bin="docker", msb_bin="msb", msb_load=False
    )
    assert env["REEF_NO_CACHE"] == "1"


def test_build_env_omits_unset_versions(monkeypatch):
    monkeypatch.delenv("OPENCLAW_VERSION", raising=False)
    monkeypatch.delenv("CLAWBITS_PLUGIN_VERSION", raising=False)
    env = _build_env(BuildImageSpec(), docker_bin="docker", msb_bin="msb", msb_load=False)
    # Blank fields ⇒ build.sh keeps its own defaults (Dockerfile pin / local tree).
    assert "OPENCLAW_VERSION" not in env
    assert "CLAWBITS_PLUGIN_VERSION" not in env


def test_build_env_ironclaw_ignores_version_overrides(monkeypatch):
    # IronClaw derives its engine/channel versions from source, so the openclaw
    # build-args are never set for an ironclaw build.
    monkeypatch.delenv("OPENCLAW_VERSION", raising=False)
    monkeypatch.delenv("CLAWBITS_PLUGIN_VERSION", raising=False)
    env = _build_env(
        BuildImageSpec(agent_type="ironclaw", runtime_version="9", component_version="9"),
        docker_bin="docker",
        msb_bin="msb",
        msb_load=False,
    )
    assert "OPENCLAW_VERSION" not in env
    assert "CLAWBITS_PLUGIN_VERSION" not in env


def test_build_sh_selected_per_agent_type():
    from reef.image_ops import _build_sh

    assert _build_sh("ironclaw").parent.name == "ironclaw-runtime"
    assert _build_sh("openclaw").parent.name == "openclaw-runtime"
    assert _build_sh("hermes").parent.name == "hermes-runtime"
    # Every registered runtime ships the script the builder streams.
    assert _build_sh("hermes").is_file()


def test_build_sh_unknown_type_cannot_escape_the_images_dir():
    # agent_type reaches this from the request body, so an unregistered value must
    # fall back to openclaw — never interpolate into an arbitrary path.
    from reef.image_ops import _build_sh

    assert _build_sh("../../../etc").parent.name == "openclaw-runtime"


def test_build_env_hermes_ignores_version_overrides(monkeypatch):
    # Hermes takes its engine from the base image and its plugin from this tree,
    # so (like IronClaw) the openclaw build-args are never set for a hermes build.
    monkeypatch.delenv("OPENCLAW_VERSION", raising=False)
    monkeypatch.delenv("CLAWBITS_PLUGIN_VERSION", raising=False)
    env = _build_env(
        BuildImageSpec(agent_type="hermes", runtime_version="9", component_version="9"),
        docker_bin="docker",
        msb_bin="msb",
        msb_load=False,
    )
    assert "OPENCLAW_VERSION" not in env
    assert "CLAWBITS_PLUGIN_VERSION" not in env


def test_hermes_repo_is_registered(monkeypatch):
    # The reef-hm repo is wired like the other two: its own floating tag + env
    # override, and tags route back to the hermes agent type.
    from reef.image_ops import _agent_type_for_tag, active_tag

    monkeypatch.delenv("REEF_HERMES_IMAGE", raising=False)
    assert active_tag("hermes") == "reef-hm:plugin"
    monkeypatch.setenv("REEF_HERMES_IMAGE", "reef-hm:pinned")
    assert active_tag("hermes") == "reef-hm:pinned"
    assert _agent_type_for_tag("reef-hm:hm0.4.0-pl0.1.2") == "hermes"


def test_activate_image_api():
    rt = FakeAdminRuntime()
    rt.image_list = [_img("reef-oc:0.5.0")]  # activate validates the tag exists
    client = _client(rt)
    r = client.post("/images/activate", json={"tag": "reef-oc:0.5.0"})
    assert r.status_code == 204
    assert rt.activated == ["reef-oc:0.5.0"]


def test_activate_unknown_tag_is_422():
    rt = FakeAdminRuntime()  # empty image list ⇒ the tag is unknown
    r = _client(rt).post("/images/activate", json={"tag": "reef-oc:nope"})
    assert r.status_code == 422


def test_activate_ironclaw_tag_repoints_ironclaw_active(monkeypatch):
    # The mis-tag fix: activating a reef-ic:* image must re-point reef-ic:channel,
    # never the openclaw floating tag.
    from reef.image_ops import activate_image

    monkeypatch.delenv("REEF_OPENCLAW_IMAGE", raising=False)
    monkeypatch.delenv("REEF_IRONCLAW_IMAGE", raising=False)
    tagged: list[tuple[str, str]] = []

    async def run(argv):
        if argv[:2] == ["docker", "tag"]:
            tagged.append((argv[2], argv[3]))
        return (0, "", "")

    asyncio.run(
        activate_image(
            "reef-ic:ic0.3.1-ch0.1.0",
            docker_bin="docker",
            msb_bin="msb",
            msb_load=False,
            runner=run,
        )
    )
    assert tagged == [("reef-ic:ic0.3.1-ch0.1.0", "reef-ic:channel")]


def test_image_status_api(monkeypatch):
    # Floors disabled ⇒ deterministic: build_available is False, and every runtime
    # is still reported with the active image's baked versions.
    monkeypatch.setenv("REEF_VERSION_CHECK", "0")
    rt = FakeAdminRuntime()
    rt.image_list = [_img("reef-oc:plugin", active=True)]
    body = _client(rt).get("/images/status").json()
    assert body["enabled"] is False
    by_type = {r["agent_type"]: r for r in body["runtimes"]}
    assert set(by_type) == {"openclaw", "ironclaw", "hermes"}
    assert by_type["openclaw"]["active_runtime_version"] == "2026.6.9"
    assert by_type["openclaw"]["build_available"] is False
    assert by_type["ironclaw"]["active_runtime_version"] is None
    # Hermes has no image built here ⇒ no active versions, nothing to offer.
    assert by_type["hermes"]["active_runtime_version"] is None
    assert by_type["hermes"]["build_available"] is False


def test_images_admin_gated(monkeypatch):
    monkeypatch.setenv("REEF_ADMIN_TOKEN", "s3cret")
    client = _client()
    assert client.get("/images").status_code == 401
    assert client.get("/images", headers={"Authorization": "Bearer s3cret"}).status_code == 200
