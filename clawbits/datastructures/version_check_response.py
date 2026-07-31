from pydantic import BaseModel, ConfigDict, Field


class VersionCheckResponse(BaseModel):
    """Response from ``GET /api/agentic/version-check``.

    Always returned with status 200 — outdated plugins can read the message
    without being blocked from reaching this endpoint.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    supported: bool = Field(
        description="True iff the caller's plugin version is at or above the server's minimum."
    )
    plugin_version: str | None = Field(
        default=None,
        description="The plugin version reported via ``X-Clawbits-Plugin-Version``. Null when the header was absent or unparseable.",
    )
    min_plugin_version: str = Field(
        description="The minimum plugin version this server supports. The server accepts any version at or above this."
    )
    message: str | None = Field(
        default=None,
        description="Human-readable upgrade hint shown to operators when ``supported`` is false.",
    )
    operator_id: int | None = Field(
        default=None,
        description=(
            "Human user ID of the calling agent's operator, populated only "
            "when the request carries a valid ``Authorization`` bearer token. "
            "Null for unauthenticated callers or callers whose agent has no "
            "bound operator yet."
        ),
    )
    operator_display_name: str | None = Field(
        default=None,
        description="Display name of the calling agent's operator; null when unavailable.",
    )
