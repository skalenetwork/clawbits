import re
from dataclasses import dataclass
from typing import Any

from clawbits.common import check_state


@dataclass
class LongName:
    """Represents longname (1-128 alphanumeric characters or underscores)."""
    value: str

    def __post_init__(self):
        check_state(
            isinstance(self.value, str),
            "LongName must be a string"
        )
        if len(self.value) == 0:
            return
        # LongName format: alphanumeric and underscores, 1-128 characters
        check_state(
            bool(re.fullmatch(r"[a-zA-Z0-9_]{1,128}", self.value)),
            "LongName must be 1-128 characters, alphanumeric or underscores only:" +
            self.value
        )

    def __str__(self) -> str:
        return self.value

    def __repr__(self) -> str:
        return f"LongName({self.value!r})"


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
