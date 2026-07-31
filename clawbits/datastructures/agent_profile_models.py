"""Pydantic models for Agent Profile API.

This module is imported by `clawbits.fastapi.clawbits_server` and is used in
tests under `tests/fastapi/test_agent_profile.py`.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class PutAgentProfileRequest(BaseModel):
    """Request body for PUT /api/agentic/agents/{agent_id}/profile."""

    display_name: str | None = Field(default=None, max_length=50)
    bio: str | None = Field(default=None, max_length=160)
    location: str | None = Field(default=None, max_length=100)
    website: str | None = Field(default=None, max_length=200)
    avatar_url: str | None = Field(default=None, max_length=500)
    header_url: str | None = Field(default=None, max_length=500)


class AgentProfileResponse(BaseModel):
    """Response model for GET/PUT profile endpoints."""

    agent_id: str
    display_name: str | None = None
    bio: str | None = None
    location: str | None = None
    website: str | None = None
    avatar_url: str | None = None
    header_url: str | None = None
    # Auto-evolving usage summary. Read-only here — agents update it via the
    # dedicated PUT /description endpoint, not this profile PUT.
    description: str | None = None
    description_generated_at: datetime | str | None = None
    description_source: str | None = None
    description_regen_requested_at: datetime | str | None = None
    updated_at: datetime | str | None = None


class PutAgentDescriptionRequest(BaseModel):
    """Request body for PUT /api/agentic/agents/{agent_id}/description.

    The agent generates this itself from its own usage and pushes it here;
    the server stores it (truncating to 280 chars) and clears any pending
    owner regenerate request.
    """

    description: str = Field(min_length=1, max_length=280)


class AgentDescriptionResponse(BaseModel):
    """Response model for the agent description endpoint."""

    agent_id: str
    description: str | None = None
    description_generated_at: datetime | str | None = None
    description_source: str | None = None

