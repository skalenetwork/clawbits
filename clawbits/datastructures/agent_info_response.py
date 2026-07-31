from pydantic import BaseModel, ConfigDict, Field


class AgentInfoResponse(BaseModel):
    """Agent install-time context: the org the agent belongs to and the
    operator who controls it. Returned by ``GET /api/agentic/agents/{id}/info``.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    agent_id: str = Field(description="Agent identifier")
    org_id: str | None = Field(description="Org the agent belongs to; null for legacy unbound agents")
    org_name: str | None = Field(default=None, description="Org name (slug)")
    org_display_name: str | None = Field(default=None, description="Org display name")
    operator_id: int | None = Field(description="Human user ID of the operator; null for legacy unbound agents")
    operator_email: str | None = Field(default=None, description="Operator's email address")
    operator_display_name: str | None = Field(default=None, description="Operator's display name")
    inter_agent_mode_enabled: bool = Field(
        default=False,
        description=(
            "If true, the agent may process other agents' messages and should "
            "tag replies to the sender. False means human-authored requests only."
        ),
    )
    snoozed: bool = Field(
        default=False,
        description=(
            "If true, the agent should stay connected but ignore inbound "
            "requests until the operator switches it back on."
        ),
    )
    inter_agent_message_limit: int = Field(
        default=10,
        description=(
            "Maximum consecutive agent-authored turns to process in inter-agent "
            "mode before pausing for human guidance."
        ),
    )
    lobstertalk_enabled: bool = Field(
        default=False,
        description=(
            "If true, a LobsterTalk sidecar should periodically evaluate the "
            "agent's channels and nudge the agent when its input is needed."
        ),
    )
    lobstertalk_ollama_host: str | None = Field(
        default=None,
        description=(
            "Ollama base URL for the sidecar's decision model; null means the "
            "sidecar uses its local default."
        ),
    )
    lobstertalk_ollama_model: str | None = Field(
        default=None,
        description=(
            "Ollama model tag for the sidecar's decision model; null + enabled "
            "means the sidecar idles until a model is configured."
        ),
    )
    lobstertalk_interval_seconds: int = Field(
        default=60,
        description="Seconds between LobsterTalk sidecar evaluation cycles.",
    )
    lobstertalk_message_limit: int = Field(
        default=100,
        description="Newest posts the sidecar reads per channel each cycle.",
    )
    description: str | None = Field(
        default=None,
        description="The agent's current public description, if any.",
    )
    description_regen_requested: bool = Field(
        default=False,
        description=(
            "True when an owner has asked the agent to regenerate its "
            "description. The agent should produce a fresh summary of what it's "
            "used for and PUT it to /description, which clears this flag."
        ),
    )
