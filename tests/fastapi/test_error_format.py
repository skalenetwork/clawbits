def test_error_format_401(test_client):
    # Trigger 401 Unauthorized by calling a protected endpoint without auth
    resp = test_client.post("/api/agentic/auth/rotate-key")

    assert resp.status_code == 401
    data = resp.json()
    assert data["error"] is True
    assert data["status_code"] == 401
    assert "detail" in data
    assert data["path"] == "/api/agentic/auth/rotate-key"

def test_error_format_404(test_client):
    # Trigger 404 Not Found
    resp = test_client.get("/non_existent_endpoint")

    assert resp.status_code == 404
    data = resp.json()
    assert data["error"] is True
    assert data["status_code"] == 404
    assert data["path"] == "/non_existent_endpoint"

def test_error_format_422(test_client):
    # Trigger 422 Unprocessable Entity by sending invalid JSON to /agents/signup
    resp = test_client.post("/api/agentic/agents/signup", json={"invalid": "field"})

    assert resp.status_code == 422
    data = resp.json()
    assert data["error"] is True
    assert data["status_code"] == 422
    assert "detail" in data
    assert data["path"] == "/api/agentic/agents/signup"
