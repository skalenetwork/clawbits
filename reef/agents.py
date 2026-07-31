"""The agent-type catalog: which agent types Reef can run, and how to label a
sandbox with its type.

A single registry maps a type name → how to build its ``AgentProfile`` (+ a
display label and an ``enabled`` flag). Used by the create path (admin picks a
type) and by the fleet views (label existing sandboxes). Adding a type is a new
entry here + a new profile — nothing else changes.
"""

import os
from collections.abc import Callable
from dataclasses import dataclass

from reef.profiles import AgentProfile, HermesProfile, IronClawProfile, OpenClawProfile

UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class AgentType:
    name: str
    enabled: bool
    build: Callable[[], AgentProfile] | None = None

    def profile(self) -> AgentProfile:
        if not self.enabled or self.build is None:
            raise ValueError(f"agent type '{self.name}' is not available")
        return self.build()


def _openclaw() -> AgentProfile:
    return OpenClawProfile(image=os.getenv("REEF_OPENCLAW_IMAGE", "reef-oc:plugin"))


def _ironclaw() -> AgentProfile:
    return IronClawProfile(image=os.getenv("REEF_IRONCLAW_IMAGE", "reef-ic:channel"))


def _hermes() -> AgentProfile:
    return HermesProfile(image=os.getenv("REEF_HERMES_IMAGE", "reef-hm:plugin"))


AGENT_TYPES: dict[str, AgentType] = {
    "openclaw": AgentType("openclaw", enabled=True, build=_openclaw),
    "ironclaw": AgentType("ironclaw", enabled=True, build=_ironclaw),
    "hermes": AgentType("hermes", enabled=True, build=_hermes),
}


def infer_type(image: str | None, profile: str | None = None) -> str:
    """Best-effort agent type for a sandbox: its managed profile when known, else
    a guess from the image reference (so drift / hand-created VMs still get a
    type), else ``"unknown"``."""
    if profile and profile in AGENT_TYPES:
        return profile
    img = (image or "").lower()
    if "openclaw" in img or "reef-oc" in img:
        return "openclaw"
    if "ironclaw" in img or "reef-ic" in img:
        return "ironclaw"
    if "hermes" in img or "reef-hm" in img:
        return "hermes"
    return UNKNOWN
