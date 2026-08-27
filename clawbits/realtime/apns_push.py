"""Direct APNs push for the native iOS app — no relay in the path.

Mirrors the web-push transport contract: sends return "ok" | "dead" |
"error", and dead rows are pruned by the shared dispatcher. Credentials
come from dotenvx like VAPID — the .p8 contents encrypted, key id / team
id / topic plain (none of those three is secret):

    dotenvx set CLAWBITS_APNS_KEY "$(cat AuthKey_XYZ.p8)" -f .env.production
    dotenvx set CLAWBITS_APNS_KEY_ID 'XYZ' --plain -f .env.production
    dotenvx set CLAWBITS_APNS_TEAM_ID 'KNNT2S5R84' --plain -f .env.production

When unset the whole surface is inert — endpoints 404, fan-out no-ops — so
dev/test without keys behave exactly as before.
"""

from __future__ import annotations

import asyncio
import binascii
import json
import logging
import os
import time

import httpx
import jwt

log = logging.getLogger(__name__)

_APNS_HOST = "https://api.push.apple.com"
# Dev builds carry a `.dev` bundle-id suffix; point the topic at whichever
# binary should receive the pushes via CLAWBITS_APNS_TOPIC.
APNS_TOPIC = os.environ.get("CLAWBITS_APNS_TOPIC", "").strip() or "ai.clawbits.mobile"
_KEY = os.environ.get("CLAWBITS_APNS_KEY", "").strip()
_KEY_ID = os.environ.get("CLAWBITS_APNS_KEY_ID", "").strip()
_TEAM_ID = os.environ.get("CLAWBITS_APNS_TEAM_ID", "").strip()

_MAX_CONCURRENCY = 8
# APNs accepts provider tokens for 1h; refresh at 50m.
_TOKEN_TTL_S = 50 * 60
_provider_token: str | None = None
_provider_token_issued = 0.0

MAX_DEVICE_TOKEN_LEN = 200


def apns_configured() -> bool:
    """True only when all three credentials are present."""
    return bool(_KEY and _KEY_ID and _TEAM_ID)


def validate_device_token(token: str) -> None:
    """Raise ``ValueError`` unless ``token`` is a hex APNs device token."""
    if not token or len(token) > MAX_DEVICE_TOKEN_LEN:
        raise ValueError(f"device token length out of range: {len(token)}")
    try:
        binascii.unhexlify(token)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("device token is not hex") from exc


def _bearer_token() -> str:
    global _provider_token, _provider_token_issued
    fresh = (
        _provider_token is not None
        and time.monotonic() - _provider_token_issued < _TOKEN_TTL_S
    )
    if not fresh:
        _provider_token = jwt.encode(
            {"iss": _TEAM_ID, "iat": int(time.time())},
            _KEY,
            algorithm="ES256",
            headers={"kid": _KEY_ID},
        )
        _provider_token_issued = time.monotonic()
    assert _provider_token is not None
    return _provider_token


def send_apns(device_token: str, title: str, body: str, channel_id: str) -> str:
    """Send one alert. Blocking; runs in a worker thread.

    Returns "ok" | "dead" (token gone — prune it) | "error".
    """
    payload = json.dumps(
        {
            "aps": {
                "alert": {"title": title, "body": body},
                "sound": "default",
                "thread-id": channel_id,
            },
            "channelId": channel_id,
        },
        separators=(",", ":"),
    )
    try:
        response = httpx.post(
            f"{_APNS_HOST}/3/device/{device_token}",
            content=payload,
            headers={
                "authorization": f"bearer {_bearer_token()}",
                "apns-topic": APNS_TOPIC,
                "apns-push-type": "alert",
                "apns-priority": "10",
                "apns-collapse-id": channel_id[:64],
            },
            timeout=10,
            http2=True,
        )
    except Exception as exc:
        log.warning("apns: send error: %s", exc)
        return "error"
    if response.status_code == 200:
        return "ok"
    reason = ""
    try:
        reason = str(response.json().get("reason") or "")
    except Exception:
        pass
    if response.status_code in (400, 403, 410) and reason in (
        "BadDeviceToken",
        "Unregistered",
        "TopicDisallowed",
    ):
        return "dead"
    log.warning("apns: send failed status=%s reason=%s", response.status_code, reason)
    return "error"


async def fan_out(
    devices: list[dict], title: str, body: str, channel_id: str
) -> list[int]:
    """Alert every device concurrently; returns dead row ids for pruning."""
    if not devices or not apns_configured():
        return []
    sem = asyncio.Semaphore(_MAX_CONCURRENCY)

    async def one(device: dict) -> tuple[int | None, str]:
        async with sem:
            return device["id"], await asyncio.to_thread(
                send_apns, device["token"], title, body, channel_id
            )

    results = await asyncio.gather(*(one(d) for d in devices))
    return [did for did, status in results if status == "dead"]
