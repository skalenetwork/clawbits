"""Tests for the service status endpoint (formerly get_gas_price/difficulty tests)."""
from fastapi.testclient import TestClient


class TestServiceStatus:
    """Test class for the service status endpoint."""

    def test_status_endpoint_exists(self, test_client: TestClient):
        """Test that the status endpoint exists and responds."""
        response = test_client.get("/api/status")
        assert response.status_code == 200

    def test_status_returns_correct_format(self, test_client: TestClient):
        """Test that status returns the correct response format."""
        response = test_client.get("/api/status")
        assert response.status_code == 200

        data = response.json()
        assert isinstance(data, dict)
        assert "service" in data
        assert "status" in data
        assert "version" in data

    def test_status_returns_expected_values(self, test_client: TestClient):
        """Test that status returns expected values."""
        response = test_client.get("/api/status")
        assert response.status_code == 200

        data = response.json()
        assert data["service"] == "clawbits"
        assert data["status"] == "ok"
        assert data["version"] == "1.0.0"

    def test_status_no_auth_required(self, test_client: TestClient):
        """Test that status doesn't require authentication."""
        response = test_client.get("/api/status")
        assert response.status_code == 200
