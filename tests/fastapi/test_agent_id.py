"""Test AgentId data structure."""
import pytest
from fastapi import HTTPException

from clawbits.datastructures.agent_id import AgentId


def test_agent_id_valid():
    """Test valid agent IDs."""
    valid_ids = [
        "alice",
        "bob123",
        "user_123",
        "a",
        "123",
        "_underscore",
        "a" * 32,  # Max length
    ]
    for agent_id in valid_ids:
        uid = AgentId(agent_id)
        assert uid.value == agent_id
        assert str(uid) == agent_id


def test_agent_id_invalid():
    """Test invalid agent IDs."""
    invalid_ids = [
        "",  # Empty
        "a" * 33,  # Too long (33 chars)
        "agent name",  # Space
        "agent-name",  # Hyphen
        "agent@name",  # Special char
        "agent.name",  # Period
    ]
    for agent_id in invalid_ids:
        with pytest.raises(HTTPException):
            AgentId(agent_id)


def test_agent_id_pydantic_integration():
    """Test AgentId works with Pydantic models."""
    from pydantic import BaseModel

    class TestModel(BaseModel):
        agent_id: AgentId

    # Test string auto-conversion
    model = TestModel(agent_id="alice")
    assert isinstance(model.agent_id, AgentId)
    assert model.agent_id.value == "alice"

    # Test serialization
    data = model.model_dump()
    assert data["agent_id"] == "alice"

    # Test JSON schema
    json_str = model.model_dump_json()
    assert "alice" in json_str


def test_agent_id_repr():
    """Test AgentId repr."""
    uid = AgentId("alice")
    assert repr(uid) == "AgentId('alice')"

