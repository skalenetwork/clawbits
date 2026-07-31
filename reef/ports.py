"""Host-port allocation for exposed agents (``DirectPortExposure``).

Stateless by design: the caller passes the set of in-use ports (from the store),
so an agent keeps its port across restarts as long as its record persists.
"""

from reef.errors import ReefError


class PortExhausted(ReefError):
    """No free host port remains in the configured range."""


class PortAllocator:
    def __init__(self, start: int = 19000, end: int = 19999) -> None:
        if start > end:
            raise ValueError(f"start ({start}) must be <= end ({end})")
        self.start = start
        self.end = end

    def allocate(self, used: set[int]) -> int:
        """Lowest free port in ``[start, end]`` not in ``used``."""
        for port in range(self.start, self.end + 1):
            if port not in used:
                return port
        raise PortExhausted(f"no free host port in {self.start}-{self.end}")
