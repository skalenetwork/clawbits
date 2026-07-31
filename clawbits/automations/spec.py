"""Canonicalization + hashing for automation desired specs.

A ``desired_spec`` is a normalized OpenClaw cron create/update payload authored
in the Clawbits UI — NOT a raw ``CronJob`` (runtime-owned fields like ``id`` /
``state`` / ``createdAtMs`` live in the reported mirror, never in desired
state). We canonicalize it to a stable form so ``spec_hash`` comparisons are
order-independent, and validate the minimal shape OpenClaw ``cron.add`` needs.

Field set verified against OpenClaw ``2026.6.10`` (see
``docs/protocol/OPENCLAW_AUTOMATIONS_INTEGRATION_STRATEGY.md`` §3.3):
``cron.add`` requires ``name``, ``schedule``, ``sessionTarget``, ``wakeMode``,
``payload``; ``delivery`` / ``failureAlert`` / ``enabled`` are optional.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

# Top-level keys we keep in a normalized desired_spec. Mirrors the OpenClaw
# cron.add param set; unknown keys are dropped so an over-eager client cannot
# smuggle runtime-owned fields (id/state/createdAtMs/updatedAtMs) into desired
# state.
_ALLOWED_SPEC_KEYS = frozenset(
    {
        "name",
        "description",
        "schedule",
        "sessionTarget",
        "wakeMode",
        "payload",
        "delivery",
        "failureAlert",
        "enabled",
        "agentId",
        "sessionKey",
        "deleteAfterRun",
    }
)

# Required by OpenClaw cron.add. ``sessionTarget`` and ``wakeMode`` have NO
# gateway default — the UI/plugin must always populate them (see strategy §3.3).
_REQUIRED_SPEC_KEYS = ("name", "schedule", "sessionTarget", "wakeMode", "payload")


class SpecValidationError(ValueError):
    """Raised when a ``desired_spec`` is missing required cron fields."""


def _normalize_delivery(delivery: Any) -> dict[str, Any] | None:
    """Reduce an operator-authored ``delivery`` to the only shape Clawbits
    supports: announce to a channel/DM the agent is in.

    The operator may only choose *where* (``to`` = a channel id); the runtime
    fields (``channel``/``accountId``) are filled by the plugin, and ``mode`` is
    pinned to ``announce`` so a client cannot smuggle a ``webhook`` route that
    would POST the agent's output to an arbitrary URL. Returns ``None`` (drop
    the key → fall back to the agent's owner DM) when there is no usable target.
    """
    if not isinstance(delivery, dict):
        return None
    to = delivery.get("to")
    if not isinstance(to, str) or not to.strip():
        return None
    return {"mode": "announce", "to": to.strip()}


def normalize_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """Return ``spec`` reduced to the allowed cron keys (drops unknowns).

    ``delivery`` is further reduced to ``{mode: 'announce', to}`` (see
    :func:`_normalize_delivery`); absent/empty → dropped so the plugin routes to
    the agent's owner DM by default.
    """
    if not isinstance(spec, dict):
        raise SpecValidationError("desired_spec must be an object")
    result = {k: spec[k] for k in _ALLOWED_SPEC_KEYS if k in spec}
    if "delivery" in result:
        delivery = _normalize_delivery(result["delivery"])
        if delivery is None:
            del result["delivery"]
        else:
            result["delivery"] = delivery
    return result


def validate_spec(spec: dict[str, Any]) -> None:
    """Assert the minimal OpenClaw ``cron.add`` shape, else raise."""
    if not isinstance(spec, dict):
        raise SpecValidationError("desired_spec must be an object")
    missing = [k for k in _REQUIRED_SPEC_KEYS if spec.get(k) in (None, "", {})]
    if missing:
        raise SpecValidationError(
            "desired_spec missing required field(s): " + ", ".join(missing)
        )


def canonical_json(value: Any) -> str:
    """Deterministic JSON (sorted keys, no whitespace) for hashing/compare.

    ``sort_keys`` recurses into nested objects, so two specs that differ only
    in key order hash identically.
    """
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )


def spec_hash(spec: dict[str, Any]) -> str:
    """Stable content hash of a (normalized) ``desired_spec``."""
    return hashlib.sha256(canonical_json(spec).encode("utf-8")).hexdigest()
