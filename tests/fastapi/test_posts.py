

def test_post_post_success(test_client, api_key):
    """Test that an agent can post a post successfully."""
    headers = {
        "Authorization": f"Bearer {api_key}",
    }

    post_data = {
        "message_type": "say",
        "message": "Hello world! This is my first post."
    }

    resp = test_client.post("/api/agentic/posts", json=post_data, headers=headers)
    assert resp.status_code == 200

    data = resp.json()
    assert "post_id" in data
    assert data["message_type"] == "say"
    assert data["message"] == "Hello world! This is my first post."
    assert "agent_id" in data
    assert "timestamp" in data


def test_post_post_different_types(test_client, api_key):
    """Test posting posts with different message types."""
    for msg_type in ["whisper", "say", "shout"]:
        headers = {
            "Authorization": f"Bearer {api_key}",
        }

        post_data = {
            "message_type": msg_type,
            "message": f"This is a {msg_type} post."
        }

        resp = test_client.post("/api/agentic/posts", json=post_data, headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["message_type"] == msg_type


def test_post_post_invalid_type(test_client, api_key):
    """Test that posting a post with invalid message type fails."""
    headers = {
        "Authorization": f"Bearer {api_key}",
    }

    post_data = {
        "message_type": "invalid_type",
        "message": "This should fail."
    }

    resp = test_client.post("/api/agentic/posts", json=post_data, headers=headers)
    assert resp.status_code == 422  # Validation error


def test_post_post_empty_message(test_client, api_key):
    """Test that posting a post with empty message fails."""
    headers = {
        "Authorization": f"Bearer {api_key}",
    }

    post_data = {
        "message_type": "say",
        "message": ""
    }

    resp = test_client.post("/api/agentic/posts", json=post_data, headers=headers)
    assert resp.status_code == 422  # Validation error


def test_post_post_missing_auth(test_client):
    """Test that posting a post without auth fails."""
    post_data = {
        "message_type": "say",
        "message": "This should fail."
    }

    resp = test_client.post("/api/agentic/posts", json=post_data)
    assert resp.status_code == 401


def test_post_post_without_auth(test_client, api_key):
    """Test that posting without Authorization header fails."""
    post_data = {
        "message_type": "say",
        "message": "This should fail."
    }

    resp = test_client.post("/api/agentic/posts", json=post_data)
    assert resp.status_code == 401


def test_post_post_long_message(test_client, api_key):
    """Test that posting a post with a long message (within limits) succeeds."""
    headers = {
        "Authorization": f"Bearer {api_key}",
    }

    # Create a message that's close to the 70 character limit
    long_message = "A" * 70

    post_data = {
        "message_type": "shout",
        "message": long_message
    }

    resp = test_client.post("/api/agentic/posts", json=post_data, headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["message"] == long_message


def test_post_post_too_long_message(test_client, api_key):
    """Test that posting a post with a message that's too long fails."""
    headers = {
        "Authorization": f"Bearer {api_key}",
    }

    # Create a message that exceeds the 70 character limit
    too_long_message = "A" * 71

    post_data = {
        "message_type": "say",
        "message": too_long_message
    }

    resp = test_client.post("/api/agentic/posts", json=post_data, headers=headers)
    assert resp.status_code == 422  # Validation error


def test_get_agent_posts(test_client, api_key):
    """Test retrieving posts from a specific agent."""
    # First, post a few posts
    for i in range(3):
        headers = {
            "Authorization": f"Bearer {api_key}",
        }

        post_data = {
            "message_type": "say",
            "message": f"Test post {i}"
        }

        resp = test_client.post("/api/agentic/posts", json=post_data, headers=headers)
        assert resp.status_code == 200

    # Get the user ID from one of the responses
    headers = {
        "Authorization": f"Bearer {api_key}",
    }

    post_data = {
        "message_type": "say",
        "message": "Final test post"
    }

    resp = test_client.post("/api/agentic/posts", json=post_data, headers=headers)
    assert resp.status_code == 200
    agent_id = resp.json()["agent_id"]

    # Now get all posts from this agent
    headers = {"Authorization": f"Bearer {api_key}"}
    resp = test_client.get(f"/api/agentic/agents/{agent_id}/posts", headers=headers)
    assert resp.status_code == 200

    data = resp.json()
    assert "posts" in data
    assert "total" in data
    assert len(data["posts"]) >= 4  # We posted at least 4 posts


def test_get_all_posts(test_client, api_key):
    """Test retrieving all posts from all agents."""
    # Post a post first
    headers = {
        "Authorization": f"Bearer {api_key}",
    }

    post_data = {
        "message_type": "say",
        "message": "Test post for get all"
    }

    resp = test_client.post("/api/agentic/posts", json=post_data, headers=headers)
    assert resp.status_code == 200

    # Now get all posts
    headers = {"Authorization": f"Bearer {api_key}"}
    resp = test_client.get("/api/agentic/posts", headers=headers)
    assert resp.status_code == 200

    data = resp.json()
    assert "posts" in data
    assert "total" in data
    assert len(data["posts"]) >= 1


def test_get_posts_unauthorized(test_client):
    """Test that getting posts without auth fails."""
    resp = test_client.get("/api/agentic/posts")
    assert resp.status_code == 401

    resp = test_client.get("/api/agentic/agents/some_agent/posts")
    assert resp.status_code == 401


def test_get_posts_pagination(test_client, api_key):
    """Test pagination when getting all posts."""
    headers = {"Authorization": f"Bearer {api_key}"}

    # Test with limit parameter
    resp = test_client.get("/api/agentic/posts?limit=2", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "posts" in data
    assert len(data["posts"]) <= 2

    # Test with offset parameter
    resp = test_client.get("/api/agentic/posts?offset=1", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "posts" in data
