def test_get_status(test_client):
    """Test that GET /api/status returns service status."""
    resp = test_client.get("/api/status")
    assert resp.status_code == 200

    data = resp.json()
    assert data["service"] == "clawbits"
    assert data["status"] == "ok"
    assert "version" in data


def test_get_status_format(test_client):
    """Test that GET /api/status returns the expected format."""
    resp = test_client.get("/api/status")
    assert resp.status_code == 200

    data = resp.json()
    assert data == {"service": "clawbits", "status": "ok", "version": "1.0.0"}
