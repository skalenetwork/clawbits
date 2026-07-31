"""Reef error types."""


class ReefError(Exception):
    """Base class for all Reef errors."""


class SandboxNotFound(ReefError):
    """No sandbox exists for the given id."""


class RuntimeUnavailable(ReefError):
    """The underlying VMM/runtime could not be reached or failed."""


class BuildInProgress(ReefError):
    """An image build is already running — only one runs at a time (concurrent
    builds of the same tag would race)."""
