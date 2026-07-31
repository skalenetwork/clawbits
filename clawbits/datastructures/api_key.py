import re
import secrets
import string
from dataclasses import dataclass
from typing import Any

from clawbits.common import check_state


@dataclass
class ApiKey:
    """Represents an API key (fc_ prefix + 16 alphanumeric characters)."""
    value: str

    def __post_init__(self):
        check_state(
            isinstance(self.value, str),
            "ApiKey must be a string"
        )
        check_state(
            len(self.value) > 0,
            "API key value must not be empty"
        )
        # Validate format: fc_ followed by 16 alphanumeric characters
        check_state(
            bool(re.match(r"^fc_[a-zA-Z0-9]{16}$", self.value)),
            "API key must start with 'fc_' followed by exactly 16 alphanumeric characters"
        )

    @classmethod
    def generate(cls) -> ApiKey:
        """Generate a new random API key with format fc_XXXXXXXXXXXXXXXX."""
        # Use secrets for cryptographically strong random generation
        alphabet = string.ascii_letters + string.digits  # a-z, A-Z, 0-9
        random_part = ''.join(secrets.choice(alphabet) for _ in range(16))
        return cls(f"fc_{random_part}")

    def __str__(self) -> str:
        return self.value

    def __repr__(self) -> str:
        return f"ApiKey({self.value!r})"

    @classmethod
    def __get_pydantic_core_schema__(cls, source_type: Any, handler):
        """Enable Pydantic serialization."""
        from pydantic_core import core_schema

        return core_schema.no_info_after_validator_function(
            lambda v: v if isinstance(v, cls) else cls(v),
            core_schema.union_schema([
                core_schema.is_instance_schema(cls),
                core_schema.str_schema(),
            ]),
            serialization=core_schema.plain_serializer_function_ser_schema(
                lambda instance: instance.value,
                return_schema=core_schema.str_schema(),
            ),
        )
