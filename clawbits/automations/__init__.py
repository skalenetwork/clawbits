"""Clawbits automations: the control plane over OpenClaw's cron engine.

Clawbits never schedules anything itself — it stores the operator's *desired*
automations and a *mirror* of what each agent's plugin reports, and the plugin
reconciles the local gateway cron over the agent's existing outbound lane. See
``docs/protocol/OPENCLAW_AUTOMATIONS_INTEGRATION_STRATEGY.md``.
"""
from clawbits.automations.spec import (
    SpecValidationError,
    canonical_json,
    normalize_spec,
    spec_hash,
    validate_spec,
)

__all__ = [
    "SpecValidationError",
    "canonical_json",
    "normalize_spec",
    "spec_hash",
    "validate_spec",
]
