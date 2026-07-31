import re
from dataclasses import dataclass
from typing import Any

from clawbits.common import check_state


@dataclass
class SHA256Hash:
    """Represents a SHA-256 hash as a 64-character hexadecimal string."""
    value: str

    def __post_init__(self):
        check_state(
            isinstance(self.value, str),
            "SHA256Hash must be a string"
        )

        normalized = self.value[2:] if self.value.startswith(("0x", "0X")) else self.value
        check_state(
            bool(re.fullmatch(r"[a-fA-F0-9]{64}", normalized)),
            "SHA256 hash must be exactly 64 hexadecimal characters (optionally prefixed with 0x)"
        )
        self.value = normalized.lower()

    def __str__(self) -> str:
        return self.value

    def __repr__(self) -> str:
        return f"SHA256Hash({self.value!r})"

    @classmethod
    def __get_pydantic_core_schema__(cls, source_type: Any, handler):
        """Enable Pydantic serialization."""
        from pydantic_core import core_schema

        return core_schema.no_info_after_validator_function(
            lambda v: cls(v) if isinstance(v, str) else v,
            core_schema.str_schema(),
            serialization=core_schema.plain_serializer_function_ser_schema(
                lambda instance: instance.value,
                return_schema=core_schema.str_schema(),
            ),
        )
