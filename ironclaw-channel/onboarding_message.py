#!/usr/bin/env python3
"""Install-time helpers for the IronClaw Clawbits channel.

Runs outside the WASM component so an already-built `clawbits.wasm` can still
exchange a Clawbits signup token for an API key and post the same first-contact
message the OpenClaw plugin sends during setup.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_ENDPOINT = "https://app.clawbits.ai"
CHALLENGE_ATTEMPTS = 16

# Cloudflare fronts clawbits.ai and answers the urllib default User-Agent
# (`Python-urllib/x.y`, on its bot block list) with "Error 1010: Access denied"
# before the request ever reaches the app. Any non-default UA gets through, so
# send an honest, descriptive one. Override via CLAWBITS_USER_AGENT if the rules
# ever tighten and a browser-like UA becomes necessary.
DEFAULT_USER_AGENT = "clawbits-ironclaw-channel/0.1.0"


class ApiError(RuntimeError):
    def __init__(self, status: int, path: str, detail: str) -> None:
        super().__init__(f"{status} {path}: {detail}")
        self.status = status
        self.path = path
        self.detail = detail


def read_endpoint(base_dir: Path) -> str:
    override = os.environ.get("CLAWBITS_ENDPOINT", "").strip()
    if override:
        return override.rstrip("/")

    manifest = base_dir / "clawbits.capabilities.json"
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        endpoint = str(data.get("config", {}).get("endpoint") or DEFAULT_ENDPOINT).strip()
    except Exception:
        endpoint = DEFAULT_ENDPOINT
    return endpoint.rstrip("/") or DEFAULT_ENDPOINT


def load_known_answers(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    answers: dict[str, str] = {}
    for question, answer in re.findall(r'"([^"]+)"\s*=>\s*Some\("([^"]+)"\)', text):
        answers[question] = answer
    if not answers:
        raise RuntimeError(f"no known answers parsed from {path}")
    return answers


def http_json(endpoint: str, api_key: str | None, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "User-Agent": os.environ.get("CLAWBITS_USER_AGENT") or DEFAULT_USER_AGENT,
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if data is not None:
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(f"{endpoint}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        raise ApiError(exc.code, path, raw or exc.reason) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"{method} {path}: {exc.reason}") from exc


def agent_id_from_session_token(session_token: str) -> str:
    if "-" not in session_token:
        raise RuntimeError("challenge session_token did not include agent id")
    return session_token.split("-", 1)[1]


def draw_known_challenge(endpoint: str, api_key: str, answers: dict[str, str]) -> tuple[str, str, str]:
    last_error = "no attempts made"
    for _ in range(CHALLENGE_ATTEMPTS):
        challenge = http_json(endpoint, api_key, "GET", "/api/agentic/auth/challenge")
        question = str(challenge.get("challenge") or challenge.get("challenge_question") or "")
        session_token = str(challenge.get("session_token") or "")
        answer = answers.get(question)
        if not session_token:
            last_error = "challenge response missing session_token"
            continue
        if answer is None:
            last_error = f"unknown challenge: {question}"
            continue
        return session_token, answer, agent_id_from_session_token(session_token)

    raise RuntimeError(f"known challenge draw failed after {CHALLENGE_ATTEMPTS} attempts: {last_error}")


def answer_challenge(endpoint: str, api_key: str, session_token: str, answer: str) -> None:
    http_json(
        endpoint,
        api_key,
        "POST",
        "/api/agentic/auth/challenge_response",
        {"session_token": session_token, "challenge_response": answer},
    )


def mint_tokens(endpoint: str, api_key: str, answers: dict[str, str]) -> str:
    session_token, answer, agent_id = draw_known_challenge(endpoint, api_key, answers)
    answer_challenge(endpoint, api_key, session_token, answer)
    return agent_id


def signup_agent(endpoint: str, org_id: str, signup_token: str, answers: dict[str, str]) -> dict[str, Any]:
    last_error = "no attempts made"
    for _ in range(CHALLENGE_ATTEMPTS):
        challenge = http_json(
            endpoint,
            None,
            "POST",
            "/api/agentic/agents/signup",
            {"org_id": org_id, "signup_token": signup_token},
        )
        question = str(challenge.get("challenge") or challenge.get("challenge_question") or "")
        session_token = str(challenge.get("session_token") or "")
        answer = answers.get(question)
        if not session_token:
            last_error = "signup response missing session_token"
            continue
        if answer is None:
            last_error = f"unknown signup challenge: {question}"
            continue

        created = http_json(
            endpoint,
            None,
            "POST",
            "/api/agentic/signup-commit",
            {"session_token": session_token, "challenge_response": answer},
        )
        if not created.get("api_key") or not created.get("agent_id"):
            raise RuntimeError(f"signup commit response missing agent_id/api_key: {created!r}")
        return created

    raise RuntimeError(f"signup failed after {CHALLENGE_ATTEMPTS} attempts: {last_error}")


def extract_channel_id(payload: dict[str, Any]) -> str:
    for source in (payload, payload.get("channel"), payload.get("data")):
        if isinstance(source, dict):
            value = source.get("channel_id") or source.get("id")
            if isinstance(value, str) and value.strip():
                return value.strip()
    raise RuntimeError(f"operator channel response missing channel_id: {payload!r}")


def get_optional_info(endpoint: str, api_key: str, agent_id: str) -> dict[str, Any]:
    path = f"/api/agentic/agents/{urllib.parse.quote(agent_id, safe='')}/info"
    try:
        return http_json(endpoint, api_key, "GET", path)
    except Exception as exc:
        print(f"  ! onboarding info lookup skipped: {exc}", file=sys.stderr)
        return {}


def greeting(agent_id: str, info: dict[str, Any]) -> str:
    operator = str(info.get("operator_display_name") or "").strip()
    org = str(info.get("org_display_name") or info.get("org_name") or info.get("org_id") or "").strip()

    if operator and org:
        return f"Hi {operator}! IronClaw agent {agent_id} reporting in for {org}."
    if operator:
        return f"Hi {operator}! IronClaw agent {agent_id} is connected to Clawbits."
    if org:
        return f"IronClaw agent {agent_id} reporting in for {org}."
    return f"IronClaw agent {agent_id} is connected to Clawbits."


def seen_agents(path: Path) -> set[str]:
    try:
        return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}
    except FileNotFoundError:
        return set()


def mark_seen(path: Path, agent_id: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(f"{agent_id}\n")


def post_greeting(endpoint: str, api_key: str, channel_id: str, message: str) -> None:
    path = f"/api/agentic/mm/channels/{urllib.parse.quote(channel_id, safe='')}/posts"
    http_json(endpoint, api_key, "POST", path, {"message": message, "status": "published"})


def main() -> int:
    base_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Clawbits onboarding helper for IronClaw")
    parser.add_argument("--state-file", help="newline-separated greeted agent ids")
    parser.add_argument("--answers-file", default=str(base_dir / "src" / "known_answers.rs"))
    parser.add_argument("--endpoint", default=None)
    parser.add_argument("--signup-only", action="store_true", help="exchange org/signup token for an API key and print JSON")
    parser.add_argument("--org-id", default=os.environ.get("CLAWBITS_ORG_ID"))
    parser.add_argument("--signup-token", default=os.environ.get("CLAWBITS_SIGNUP_TOKEN"))
    args = parser.parse_args()

    endpoint = (args.endpoint or read_endpoint(base_dir)).rstrip("/")
    answers = load_known_answers(Path(args.answers_file))

    if args.signup_only:
        org_id = (args.org_id or "").strip()
        signup_token = (args.signup_token or "").strip()
        if not org_id or not signup_token:
            raise RuntimeError("--org-id and --signup-token are required for --signup-only")
        created = signup_agent(endpoint, org_id, signup_token, answers)
        print(json.dumps(created, separators=(",", ":")))
        return 0

    api_key = os.environ.get("CLAWBITS_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("CLAWBITS_API_KEY is not set")
    if not args.state_file:
        raise RuntimeError("--state-file is required")

    state_file = Path(args.state_file)

    session_token, answer, agent_id = draw_known_challenge(endpoint, api_key, answers)
    if agent_id in seen_agents(state_file):
        print(f"  = onboarding greeting already sent for {agent_id}")
        return 0
    answer_challenge(endpoint, api_key, session_token, answer)

    operator_channel = http_json(
        endpoint,
        api_key,
        "GET",
        f"/api/agentic/mm/teams/{urllib.parse.quote(agent_id, safe='')}/operator-channel",
    )
    channel_id = extract_channel_id(operator_channel)
    info = get_optional_info(endpoint, api_key, agent_id)
    message = greeting(agent_id, info)

    try:
        post_greeting(endpoint, api_key, channel_id, message)
    except ApiError as exc:
        if exc.status != 402:
            raise
        # Token race or a pre-mint was consumed by another write. Top up once.
        mint_tokens(endpoint, api_key, answers)
        post_greeting(endpoint, api_key, channel_id, message)

    mark_seen(state_file, agent_id)
    print(f"  + onboarding greeting posted to Clawbits operator channel ({agent_id})")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"  ! clawbits onboarding failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
