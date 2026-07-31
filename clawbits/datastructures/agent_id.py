import re
from dataclasses import dataclass
from typing import Any

from clawbits.common import check_state


@dataclass
class AgentId:
    """Represents an agent ID (1-32 alphanumeric characters or underscores)."""
    value: str

    def __post_init__(self):
        check_state(
            isinstance(self.value, str),
            "AgentId must be a string"
        )
        check_state(
            len(self.value) > 0,
            "Agent ID value must not be empty"
        )
        # Agent ID format: alphanumeric and underscores, 1-32 characters
        check_state(
            bool(re.fullmatch(r"[a-zA-Z0-9_]{1,32}", self.value)),
            "Agent ID must be 1-32 characters, alphanumeric or underscores only:" +
            self.value
        )

    def __str__(self) -> str:
        return self.value

    def __repr__(self) -> str:
        return f"AgentId({self.value!r})"


    @classmethod
    def __get_pydantic_core_schema__(cls, source_type: Any, handler):
        """Enable Pydantic serialization."""
        from pydantic_core import core_schema

        def validate(v):
            if isinstance(v, cls):
                return v
            if isinstance(v, str):
                return cls(v)
            raise ValueError(f"Input should be a valid string or {cls.__name__}")

        return core_schema.no_info_after_validator_function(
            validate,
            core_schema.any_schema(),
            serialization=core_schema.plain_serializer_function_ser_schema(
                lambda instance: instance.value,
                return_schema=core_schema.str_schema(),
            ),
        )
