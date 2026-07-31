def test_openapi_json_is_accessible(test_client):
    """Test that the /openapi.json endpoint returns a valid JSON spec."""
    resp = test_client.get("/openapi.json")
    assert resp.status_code == 200

    # Ensure it's valid JSON
    data = resp.json()
    assert isinstance(data, dict)

    # Verify basic OpenAPI fields
    assert "openapi" in data
    assert "info" in data
    assert "paths" in data

    # Verify version and title
    assert "title" in data["info"]
    assert "version" in data["info"]


def test_openapi_custom_modifications(test_client):
    """
    Test that the custom modifications in custom_openapi() are applied.
    - title = "Clawbits API"
    - description contains "Clawbits server API"
    - fc-product-version and fc-api-version are present
    """
    resp = test_client.get("/openapi.json")
    assert resp.status_code == 200

    data = resp.json()
    info = data.get("info", {})

    assert info.get("title") == "Clawbits API"
    assert "Clawbits server API" in info.get("description", "")

    # Check custom headers injected in custom_openapi
    assert "fc-product-version" in data
    assert "fc-api-version" in data


def test_openapi_endpoints_present(test_client):
    """Test that key endpoints are present in the OpenAPI spec."""
    resp = test_client.get("/openapi.json")
    assert resp.status_code == 200

    data = resp.json()
    paths = data.get("paths", {})

    # Check for some essential endpoints
    assert "/api/status" in paths
    assert "/api/agentic/agents/signup" in paths
    assert "/api/agentic/signup-commit" in paths
    assert "/api/agentic/auth/rotate-key" in paths
    assert "/api/agentic/auth/challenge" in paths
    assert "/api/agentic/shared_content" in paths
    assert "/api/agentic/shared_content/{path}" in paths


def test_legacy_agent_messages_endpoints_removed_from_openapi(test_client):
    """Legacy /messages endpoints should not be exposed in OpenAPI."""
    resp = test_client.get("/openapi.json")
    assert resp.status_code == 200

    paths = resp.json().get("paths", {})
    assert "/api/agentic/agents/{agent_id}/messages/outgoing" not in paths
    assert "/api/agentic/agents/{agent_id}/messages/incoming" not in paths


def test_legacy_agent_messages_endpoints_return_404(test_client):
    """Legacy /messages endpoints should not be routable anymore."""
    resp = test_client.post("/api/agentic/agents/some_agent/messages/outgoing", json={"message": "hello"})
    assert resp.status_code in (404, 405)

    resp = test_client.get("/api/agentic/agents/some_agent/messages/incoming")
    assert resp.status_code in (404, 405)

