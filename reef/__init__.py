"""Reef — isolated microVM hosting for agents.

Standalone, agent-agnostic platform: one microVM per agent. clawbits depends on
Reef (never the reverse). Design & decisions: docs/REEF.md.
"""

from reef.docker_runtime import DockerRuntime
from reef.errors import ReefError, RuntimeUnavailable, SandboxNotFound
from reef.exposure import (
    DirectPortExposure,
    Exposure,
    ExposureStrategy,
    SubdomainProxyExposure,
)
from reef.fake_runtime import FakeRuntime
from reef.manager import SandboxManager
from reef.microsandbox_runtime import MicrosandboxRuntime
from reef.models import Sandbox
from reef.ports import PortAllocator
from reef.profiles import AgentProfile, HermesProfile, OpenClawProfile
from reef.reconciler import Reconciler
from reef.runtime import (
    AgentRuntime,
    DesiredState,
    Limits,
    RestartPolicy,
    SandboxSpec,
    SandboxState,
)
from reef.runtime_factory import make_exposure, make_runtime, make_store
from reef.store import InMemorySandboxStore, SandboxStore
from reef.store_sqlite import SqliteSandboxStore

__all__ = [
    "AgentProfile",
    "AgentRuntime",
    "DesiredState",
    "DirectPortExposure",
    "DockerRuntime",
    "Exposure",
    "ExposureStrategy",
    "FakeRuntime",
    "InMemorySandboxStore",
    "Limits",
    "MicrosandboxRuntime",
    "HermesProfile",
    "OpenClawProfile",
    "PortAllocator",
    "Reconciler",
    "ReefError",
    "RestartPolicy",
    "RuntimeUnavailable",
    "Sandbox",
    "SandboxManager",
    "SandboxNotFound",
    "SandboxSpec",
    "SandboxState",
    "SandboxStore",
    "SqliteSandboxStore",
    "SubdomainProxyExposure",
    "make_exposure",
    "make_runtime",
    "make_store",
]
