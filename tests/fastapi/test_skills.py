"""HTTP-level tests for the skills catalog."""
from __future__ import annotations

import io
import zipfile

import httpx
from fastapi.testclient import TestClient
from sqlmodel import Session, update

from clawbits.db.models import AgentSkillInstall, HumanUser, SkillVersion
from clawbits.skills import importer
from tests.fastapi._auth_helpers import (
    add_human_to_org,
    login_human,
    personal_org_id,
    register_human,
)
from tests.fastapi.conftest import _create_agent

GOOD_MANIFEST = {
    "name": "invoice-triage",
    "description": "Triage inbound invoices and flag the ones over budget.",
}
GOOD_BODY = "# Invoice triage\n\nRead the invoice, compare to budget, flag overruns.\n"


def _org(test_client: TestClient, email: str) -> tuple[str, str]:
    token, _ = login_human(test_client, email)
    return token, personal_org_id(test_client, token)


def _create(test_client, token, org_id, *, slug="invoice-triage", manifest=None, files=None):
    return test_client.post(
        f"/api/human/orgs/{org_id}/skills",
        json={
            "slug": slug,
            "display_name": "Invoice triage",
            "manifest": manifest or {**GOOD_MANIFEST, "name": slug},
            "body_md": GOOD_BODY,
            "files": files,
        },
        headers={"Authorization": f"Bearer {token}"},
    )


def test_create_list_and_publish(test_client: TestClient):
    token, org_id = _org(test_client, "skills-crud@clawbits.ai")
    h = {"Authorization": f"Bearer {token}"}

    r = _create(test_client, token, org_id)
    assert r.status_code == 200, r.text
    skill = r.json()
    skill_id = skill["skill_id"]
    assert skill["slug"] == "invoice-triage"
    assert skill["latest_version"] == "1.0.0"
    assert skill["is_draft"] is False
    assert skill["origin"] == "authored"
    assert skill["has_executable"] is False

    r = test_client.get(f"/api/human/orgs/{org_id}/skills", headers=h)
    assert r.status_code == 200
    assert [s["skill_id"] for s in r.json()["skills"]] == [skill_id]

    r = test_client.post(
        f"/api/human/orgs/{org_id}/skills/{skill_id}/versions",
        json={
            "manifest": {**GOOD_MANIFEST, "description": "Triage invoices, v2."},
            "body_md": "# v2\n\nNow with more triage.\n",
            "changelog": "sharper wording",
        },
        headers=h,
    )
    assert r.status_code == 200, r.text
    assert r.json()["version"] == "1.0.1"

    r = test_client.get(f"/api/human/orgs/{org_id}/skills/{skill_id}/versions", headers=h)
    assert [v["version"] for v in r.json()["versions"]] == ["1.0.1", "1.0.0"]
    first = test_client.get(
        f"/api/human/orgs/{org_id}/skills/{skill_id}/versions/{skill['latest_version_id']}",
        headers=h,
    ).json()
    assert (first["version"], first["body_md"]) == ("1.0.0", GOOD_BODY)

    detail = test_client.get(f"/api/human/orgs/{org_id}/skills/{skill_id}", headers=h).json()
    assert detail["summary"] == "Triage invoices, v2."
    assert detail["current_version"]["body_md"].startswith("# v2")


def test_normalization_neutralizers(test_client: TestClient):
    """The three neutralizers, asserted on stored state."""
    token, org_id = _org(test_client, "skills-neutral@clawbits.ai")
    h = {"Authorization": f"Bearer {token}"}
    hostile = {
        **GOOD_MANIFEST,
        "name": "hostile",
        "always": True,
        "metadata": {"openclaw": {"install": [{"type": "download", "url": "http://evil"}]}},
        "requires": {"bins": ["gh"], "config": ["secrets.token"]},
        "runtime_overrides": {"openclaw": {"metadata": {"openclaw": {"always": True}}}},
        "env_declarations": [{"name": "API_KEY", "required": True, "value": "s3cret"}],
        "totally_unknown_key": "dropped",
    }
    r = _create(test_client, token, org_id, slug="hostile", manifest=hostile)
    assert r.status_code == 200, r.text
    stored = r.json()["current_version"]["manifest"]

    assert "metadata" not in stored
    assert "always" not in stored
    assert "runtime_overrides" not in stored
    assert "totally_unknown_key" not in stored
    assert stored["requires"] == {"bins": ["gh"]}
    assert stored["env_declarations"] == [{"name": "API_KEY", "required": True}]

    # Nor through the render path.
    version_id = r.json()["latest_version_id"]
    skill_id = r.json()["skill_id"]
    rendered = test_client.get(
        f"/api/human/orgs/{org_id}/skills/{skill_id}/versions/{version_id}/render",
        headers=h,
    ).json()["content"]
    assert "install" not in rendered
    assert "evil" not in rendered
    assert "s3cret" not in rendered
    assert "secrets.token" not in rendered


def test_rejects_traversal_and_bad_slugs(test_client: TestClient):
    token, org_id = _org(test_client, "skills-paths@clawbits.ai")

    for bad_path in ("../escape.md", "references/../../x.md", "/etc/passwd", "scripts/run.sh"):
        r = _create(
            test_client,
            token,
            org_id,
            slug="pathy",
            files=[{"path": bad_path, "content": "x"}],
        )
        assert r.status_code == 400, f"{bad_path} was accepted: {r.text}"

    r = _create(test_client, token, org_id, slug="clawbits-email")
    assert r.status_code == 400
    assert "reserved" in r.json()["detail"]

    r = _create(
        test_client, token, org_id, slug="mismatch", manifest={**GOOD_MANIFEST, "name": "other"}
    )
    assert r.status_code == 400
    assert "match" in r.json()["detail"]

    r = _create(
        test_client,
        token,
        org_id,
        slug="longdesc",
        manifest={**GOOD_MANIFEST, "name": "longdesc", "description": "x" * 200},
    )
    assert r.status_code == 400


def test_reference_files_and_render(test_client: TestClient):
    token, org_id = _org(test_client, "skills-files@clawbits.ai")
    h = {"Authorization": f"Bearer {token}"}
    r = _create(
        test_client,
        token,
        org_id,
        slug="withrefs",
        manifest={**GOOD_MANIFEST, "name": "withrefs", "emoji": "🧾", "requires": {"bins": ["gh"]}},
        files=[
            {"path": "references/b.md", "content": "B"},
            {"path": "references/a.md", "content": "A"},
        ],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    files = body["current_version"]["files"]
    assert [f["path"] for f in files] == ["references/a.md", "references/b.md"]
    assert all(f["sha256"] and f["size_bytes"] for f in files)

    skill_id, version_id = body["skill_id"], body["latest_version_id"]
    r = test_client.get(
        f"/api/human/orgs/{org_id}/skills/{skill_id}/versions/{version_id}/render",
        headers=h,
    )
    assert r.status_code == 200
    out = r.json()
    assert out["path"] == "withrefs/SKILL.md"
    assert out["content"].startswith("---\n")
    assert 'name: "withrefs"' in out["content"]
    assert '"emoji": "🧾"' in out["content"]

    r = test_client.get(
        f"/api/human/orgs/{org_id}/skills/{skill_id}/versions/{version_id}/render?runtime=nope",
        headers=h,
    )
    assert r.status_code == 400


def test_fork_records_lineage_and_derives_slug(test_client: TestClient):
    token, org_id = _org(test_client, "skills-fork@clawbits.ai")
    h = {"Authorization": f"Bearer {token}"}
    src = _create(test_client, token, org_id).json()

    r = test_client.post(
        f"/api/human/orgs/{org_id}/skills/{src['skill_id']}/fork", json={}, headers=h
    )
    assert r.status_code == 200, r.text
    fork = r.json()
    assert fork["skill_id"] != src["skill_id"]
    assert fork["origin"] == "forked"
    assert fork["forked_from_skill_id"] == src["skill_id"]
    assert fork["forked_from_version_id"] == src["latest_version_id"]
    assert fork["slug"] == "invoice-triage-fork"
    assert fork["latest_version"] == "1.0.0"
    # The manifest name must follow the new slug or OpenClaw will not load it.
    assert fork["current_version"]["manifest"]["name"] == "invoice-triage-fork"

    r2 = test_client.post(
        f"/api/human/orgs/{org_id}/skills/{src['skill_id']}/fork", json={}, headers=h
    )
    assert r2.status_code == 200
    assert r2.json()["slug"] == "invoice-triage-fork-2"


def test_slug_is_taken_until_deleted(test_client: TestClient):
    token, org_id = _org(test_client, "skills-del@clawbits.ai")
    h = {"Authorization": f"Bearer {token}"}
    skill_id = _create(test_client, token, org_id).json()["skill_id"]
    assert _create(test_client, token, org_id).status_code == 409

    assert test_client.delete(
        f"/api/human/orgs/{org_id}/skills/{skill_id}", headers=h
    ).status_code == 200
    assert test_client.get(f"/api/human/orgs/{org_id}/skills", headers=h).json()["skills"] == []
    assert test_client.get(
        f"/api/human/orgs/{org_id}/skills/{skill_id}", headers=h
    ).status_code == 404
    assert _create(test_client, token, org_id).status_code == 200


def test_org_isolation_on_every_by_id_route(test_client: TestClient):
    """Org A must not reach org B's skill through any by-id route."""
    token_a, org_a = _org(test_client, "skills-iso-a@clawbits.ai")
    token_b, org_b = _org(test_client, "skills-iso-b@clawbits.ai")
    ha = {"Authorization": f"Bearer {token_a}"}

    victim = _create(test_client, token_b, org_b).json()
    vid = victim["skill_id"]
    version = f"versions/{victim['latest_version_id']}"

    for method, path, body in (
        ("GET", "", None),
        ("GET", "/versions", None),
        ("GET", f"/{version}", None),
        ("GET", f"/{version}/render", None),
        ("PATCH", "", {"display_name": "pwned"}),
        ("POST", "/versions", {"manifest": GOOD_MANIFEST, "body_md": "x"}),
        # Fork would silently copy another org's content in.
        ("POST", "/fork", {}),
        ("POST", "/installs", {"agent_ids": ["x"]}),
        ("DELETE", "", None),
    ):
        url = f"/api/human/orgs/{org_a}/skills/{vid}{path}"
        r = test_client.request(method, url, json=body, headers=ha)
        assert r.status_code == 404, (method, path)

    assert test_client.get(f"/api/human/orgs/{org_b}/skills/{vid}", headers=ha).status_code == 403
    assert test_client.get(f"/api/human/orgs/{org_b}/skills", headers=ha).status_code == 403
    assert test_client.get(
        f"/api/human/orgs/{org_b}/skills/{vid}/{version}", headers=ha
    ).status_code == 403
    r = _import(test_client, token_a, org_b, json={"url": "https://github.com/a/b"})
    assert r.status_code == 403

    assert test_client.get(
        f"/api/human/orgs/{org_b}/skills/{vid}",
        headers={"Authorization": f"Bearer {token_b}"},
    ).json()["display_name"] == "Invoice triage"


def test_content_hash_is_order_stable(test_client: TestClient):
    """The hash gates disk rewrites, so order must not move it."""
    token, org_id = _org(test_client, "skills-hash@clawbits.ai")
    files = [
        {"path": "references/a.md", "content": "A"},
        {"path": "references/b.md", "content": "B"},
    ]
    one = _create(
        test_client,
        token,
        org_id,
        slug="hash-one",
        manifest={"name": "hash-one", "description": "d", "runtimes": ["openclaw"]},
        files=files,
    ).json()
    republished = test_client.post(
        f"/api/human/orgs/{org_id}/skills/{one['skill_id']}/versions",
        json={
            "manifest": {"runtimes": ["openclaw"], "description": "d", "name": "hash-one"},
            "body_md": GOOD_BODY,
            "files": list(reversed(files)),
        },
        headers={"Authorization": f"Bearer {token}"},
    ).json()
    assert republished["content_hash"] == one["content_hash"]


IMPORTED_SKILL_MD = """---
name: Weather Brief
description: >
  Summarize the forecast
  before a trip.
version: 2.1.0
user-invocable: true
always: true
metadata:
  {
    "openclaw": {
      "emoji": "🌦",
      "requires": {"bins": ["curl"], "config": ["secrets.token"]},
      "install": [{"kind": "download", "url": "http://evil"}]
    }
  }
---

# Weather brief

Fetch the forecast, then summarize it.
"""


def _import(test_client, token, org_id, **kw):
    return test_client.post(
        f"/api/human/orgs/{org_id}/skills/import",
        headers={"Authorization": f"Bearer {token}"},
        **kw,
    )


def _upload(name: str, data: bytes) -> dict:
    return {"files": [("files", (name, data, "application/octet-stream"))]}


def _zip(entries: dict[str, bytes], *, symlink: str | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
        if symlink is not None:
            info = zipfile.ZipInfo(symlink)
            info.external_attr = 0o120777 << 16
            archive.writestr(info, "/etc/passwd")
    return buf.getvalue()


def test_import_folder_upload_drafts_without_storing(test_client: TestClient):
    token, org_id = _org(test_client, "skills-import-folder@clawbits.ai")
    files = [
        ("files", ("weather/SKILL.md", IMPORTED_SKILL_MD.encode(), "text/markdown")),
        ("files", ("weather/references/units.md", b"Celsius first.\n", "text/markdown")),
        ("files", ("weather/scripts/fetch.sh", b"curl wttr.in\n", "text/x-sh")),
        ("files", ("weather/.clawhub/lock.json", b"{}", "application/json")),
    ]
    r = _import(test_client, token, org_id, files=files)
    assert r.status_code == 200, r.text
    draft = r.json()
    assert draft["slug"] == "weather-brief"
    assert draft["display_name"] == "Weather brief"
    assert draft["source"] == {"kind": "upload"}
    assert draft["body_md"].startswith("# Weather brief")
    manifest = draft["manifest"]
    assert manifest["name"] == "weather-brief"
    assert manifest["description"] == "Summarize the forecast before a trip."
    assert manifest["version"] == "2.1.0"
    assert manifest["user_invocable"] is True
    assert manifest["emoji"] == "🌦"
    # The neutralizers apply to imports exactly as to authored skills.
    assert manifest["requires"] == {"bins": ["curl"]}
    assert "always" not in manifest and "install" not in str(manifest)
    assert draft["files"] == [{"path": "references/units.md", "content": "Celsius first.\n"}]
    assert draft["dropped"] == [
        {"path": "scripts/fetch.sh", "reason": "Scripts aren't imported; skills are text only"}
    ]

    h = {"Authorization": f"Bearer {token}"}
    assert test_client.get(f"/api/human/orgs/{org_id}/skills", headers=h).json()["skills"] == []
    created = test_client.post(
        f"/api/human/orgs/{org_id}/skills",
        json={k: draft[k] for k in ("slug", "display_name", "manifest", "body_md", "files")},
        headers=h,
    )
    assert created.status_code == 200, created.text


def test_import_zip_drops_binaries_and_assets(test_client: TestClient):
    token, org_id = _org(test_client, "skills-import-zip@clawbits.ai")
    archive = _zip({
        "repo-main/README.md": b"not part of the skill",
        "repo-main/invoice-triage/SKILL.md": (
            b"---\nname: invoice-triage\ndescription: Triage invoices.\n---\n\nBody\n"
        ),
        "repo-main/invoice-triage/references/rules.md": b"Flag over budget.",
        "repo-main/invoice-triage/references/logo.png": b"\x89PNG\r\n\x1a\n\xff\xfe",
        # Valid UTF-8, but its NULs would fail the create with a 500.
        "repo-main/invoice-triage/references/notes.md": "Notes".encode("utf-16-le"),
        "repo-main/invoice-triage/assets/template.md": b"x",
        "__MACOSX/repo-main/invoice-triage/._SKILL.md": b"\x00",
    })
    r = _import(test_client, token, org_id, **_upload("skill.zip", archive))
    assert r.status_code == 200, r.text
    draft = r.json()
    assert draft["slug"] == "invoice-triage"
    assert [f["path"] for f in draft["files"]] == ["references/rules.md"]
    assert {d["path"]: d["reason"] for d in draft["dropped"]} == {
        "assets/template.md": "Assets aren't imported; skills are text only",
        "references/logo.png": "Not a text file",
        "references/notes.md": "Not a text file",
    }


def test_import_rejects_unsafe_or_unusable_uploads(test_client: TestClient):
    token, org_id = _org(test_client, "skills-import-bad@clawbits.ai")
    good = b"---\nname: ok\ndescription: Fine.\n---\n\nBody\n"
    cases = {
        "traversal": _zip({"SKILL.md": good, "../escape.md": b"x"}),
        "symlink": _zip({"SKILL.md": good}, symlink="references/link.md"),
        "bomb": _zip({"SKILL.md": good, "references/zeros.md": b"0" * (importer.UNPACKED_MAX + 1)}),
        "no skill": _zip({"README.md": b"nothing here"}),
        "two skills": _zip({"a/SKILL.md": good, "b/SKILL.md": good}),
        "utf-16 skill": _zip({"SKILL.md": good.decode().encode("utf-16-le")}),
        "not a zip": b"PK but not really",
    }
    for label, data in cases.items():
        r = _import(test_client, token, org_id, **_upload("s.zip", data))
        assert r.status_code == 422, f"{label}: {r.text}"
        assert r.json()["detail"], label

    r = _import(test_client, token, org_id, **_upload("../SKILL.md", good))
    assert r.status_code == 422
    r = _import(test_client, token, org_id, json={"url": "https://gitlab.com/a/b/-/tree/main/s"})
    assert r.status_code == 422
    assert "GitHub" in r.json()["detail"]


def test_import_from_github_link(test_client: TestClient, monkeypatch):
    requested: list[str] = []
    skill_md = "---\nname: pr-review\ndescription: Review pull requests.\n---\n\n# Review\n"

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        requested.append(url)
        api = "https://api.github.com/repos/acme/skills/contents/"
        raw = "https://raw.githubusercontent.com/acme/skills/main/skills/pr-review/"
        listings = {
            f"{api}skills/pr-review?ref=main": [
                {"name": "SKILL.md", "type": "file"},
                {"name": "references", "type": "dir"},
                {"name": "scripts", "type": "dir"},
            ],
            f"{api}skills/pr-review/references?ref=main": [{"name": "style.md", "type": "file"}],
        }
        bodies = {f"{raw}SKILL.md": skill_md, f"{raw}references/style.md": "Be kind.\n"}
        if url in listings:
            return httpx.Response(200, json=listings[url])
        if url in bodies:
            return httpx.Response(200, text=bodies[url])
        return httpx.Response(404)

    monkeypatch.setattr(
        importer,
        "make_guarded_async_client",
        lambda **kw: httpx.AsyncClient(transport=httpx.MockTransport(handler), **kw),
    )
    token, org_id = _org(test_client, "skills-import-url@clawbits.ai")
    for link in (
        "https://github.com/acme/skills/tree/main/skills/pr-review",
        "https://github.com/acme/skills/blob/main/skills/pr-review/SKILL.md",
        "https://raw.githubusercontent.com/acme/skills/refs/heads/main/skills/pr-review/SKILL.md",
    ):
        r = _import(test_client, token, org_id, json={"url": link})
        assert r.status_code == 200, f"{link}: {r.text}"
        draft = r.json()
        assert draft["slug"] == "pr-review"
        assert draft["source"] == {"kind": "url", "url": link}
        assert draft["files"] == [{"path": "references/style.md", "content": "Be kind.\n"}]
        assert draft["dropped"] == [
            {"path": "scripts/", "reason": "Scripts aren't imported; skills are text only"}
        ]
    assert not any("scripts" in u for u in requested), "dropped folders are never fetched"

    missing = "https://github.com/acme/skills/tree/main/missing"
    r = _import(test_client, token, org_id, json={"url": missing})
    assert r.status_code == 422
    assert r.json()["detail"] == "Nothing public at that link"


NO_ATTENTION = {"failed": 0, "installing": 0, "removing": 0, "behind": 0}


def test_attention_buckets(test_client: TestClient):
    """One skill per state on a single agent, so each count is that skill's own."""
    email = "skills-attention@clawbits.ai"
    agent = _create_agent(test_client, owner_email=email)
    token, org_id = _org(test_client, email)
    h = {"Authorization": f"Bearer {token}"}
    agent_h = {"Authorization": f"Bearer {agent['api_key']}"}
    agent_skills = f"/api/human/orgs/{org_id}/agents/{agent['agent_id']}/skills"
    slugs = ("fails", "fresh", "leaving", "stale", "pinned", "current", "off-new", "off-old")
    skills = {slug: _create(test_client, token, org_id, slug=slug).json() for slug in slugs}
    for skill in skills.values():
        test_client.post(agent_skills, json={"skill_id": skill["skill_id"]}, headers=h)
    install_ids = {
        s["slug"]: s["install_id"]
        for s in test_client.get(agent_skills, headers=h).json()["skills"]
    }

    def outcome(slug: str, **kw) -> dict:
        return {
            "slug": slug,
            "status": "applied",
            "observed_generation": 99,
            "content_hash": skills[slug]["content_hash"],
            **kw,
        }

    r = test_client.post(
        "/api/agentic/skills/state",
        json={
            "report_mode": "apply",
            "skills": [
                outcome("fails", status="failed", error="disk full"),
                *(outcome(s) for s in ("leaving", "stale", "pinned", "current", "off-old")),
            ],
        },
        headers=agent_h,
    )
    assert r.status_code == 200, r.text

    test_client.patch(
        f"{agent_skills}/{install_ids['pinned']}",
        json={"pinned_version_id": skills["pinned"]["latest_version_id"]},
        headers=h,
    )
    for slug in ("off-new", "off-old"):
        test_client.patch(f"{agent_skills}/{install_ids[slug]}", json={"enabled": False}, headers=h)
    test_client.delete(f"{agent_skills}/{install_ids['leaving']}", headers=h)
    newer = {}
    for slug in ("stale", "pinned", "off-old"):
        newer[slug] = test_client.post(
            f"/api/human/orgs/{org_id}/skills/{skills[slug]['skill_id']}/versions",
            json={"manifest": {**GOOD_MANIFEST, "name": slug}, "body_md": "# v2\n"},
            headers=h,
        ).json()

    def library() -> dict[str, dict]:
        rows = test_client.get(f"/api/human/orgs/{org_id}/skills", headers=h).json()["skills"]
        return {s["slug"]: s for s in rows}

    def attention() -> dict[str, dict]:
        return {slug: s["attention"] for slug, s in library().items()}

    # Only a confirmed apply counts as installed: not requested, failed or removing.
    installed = [slug for slug, s in library().items() if s["installed_agent_count"]]
    assert sorted(installed) == ["current", "pinned", "stale"]
    assert attention() == {
        "fails": {**NO_ATTENTION, "failed": 1},
        "fresh": {**NO_ATTENTION, "installing": 1},
        "leaving": {**NO_ATTENTION, "removing": 1},
        "stale": {**NO_ATTENTION, "behind": 1},
        "pinned": NO_ATTENTION,
        "current": NO_ATTENTION,
        "off-new": NO_ATTENTION,
        "off-old": NO_ATTENTION,
    }
    detail = test_client.get(
        f"/api/human/orgs/{org_id}/skills/{skills['stale']['skill_id']}", headers=h
    ).json()
    assert detail["attention"] == {**NO_ATTENTION, "behind": 1}

    test_client.post(
        "/api/agentic/skills/state",
        json={
            "report_mode": "apply",
            "skills": [outcome("stale", content_hash=newer["stale"]["content_hash"])],
        },
        headers=agent_h,
    )
    assert attention()["stale"] == NO_ATTENTION


def test_attention_counts_only_agents_in_the_skills_org(test_client: TestClient, _test_engine):
    email = "skills-attention-own@clawbits.ai"
    own = _create_agent(test_client, owner_email=email)
    other = _create_agent(test_client, owner_email="skills-attention-other@clawbits.ai")
    token, org_id = _org(test_client, email)
    h = {"Authorization": f"Bearer {token}"}
    skill = _create(test_client, token, org_id).json()
    test_client.post(
        f"/api/human/orgs/{org_id}/agents/{own['agent_id']}/skills",
        json={"skill_id": skill["skill_id"]},
        headers=h,
    )
    with Session(_test_engine) as db:
        db.add(
            AgentSkillInstall(
                install_id="install-attention-cross-org",
                agent_id=other["agent_id"],
                org_id=org_id,
                skill_id=skill["skill_id"],
                slug=skill["slug"],
                managed_by="clawbits",
                sync_status="failed",
            )
        )
        db.commit()

    expected = {**NO_ATTENTION, "installing": 1}
    listed = test_client.get(f"/api/human/orgs/{org_id}/skills", headers=h).json()["skills"]
    assert [s["attention"] for s in listed] == [expected]
    detail = test_client.get(f"/api/human/orgs/{org_id}/skills/{skill['skill_id']}", headers=h)
    assert detail.json()["attention"] == expected


def test_versions_carry_their_author(test_client: TestClient, _test_engine):
    owner = register_human(test_client, "skills-author-a@clawbits.ai", display_name="Ada")
    token = owner["access_token"]
    org_id = personal_org_id(test_client, token)
    member = register_human(test_client, "skills-author-b@clawbits.ai", display_name="Grace")
    add_human_to_org(test_client, token, org_id, "skills-author-b@clawbits.ai")

    skill = _create(test_client, token, org_id).json()
    test_client.post(
        f"/api/human/orgs/{org_id}/skills/{skill['skill_id']}/versions",
        json={"manifest": GOOD_MANIFEST, "body_md": "# v2\n"},
        headers={"Authorization": f"Bearer {member['access_token']}"},
    )
    h = {"Authorization": f"Bearer {token}"}
    versions_path = f"/api/human/orgs/{org_id}/skills/{skill['skill_id']}/versions"

    def authors() -> list[str | None]:
        return [v["author"] for v in test_client.get(versions_path, headers=h).json()["versions"]]

    assert authors() == ["Grace", "Ada"]

    with Session(_test_engine) as db:
        db.exec(
            update(HumanUser)
            .where(HumanUser.id == member["user"]["id"])
            .values(display_name=None)
        )
        db.exec(
            update(SkillVersion)
            .where(SkillVersion.version_id == skill["latest_version_id"])
            .values(published_by=None)
        )
        db.commit()

    assert authors() == ["skills-author-b@clawbits.ai", None]
