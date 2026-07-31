

def test_upload_file_exceeds_64kb(test_client, api_key):
    # 70 KB file (exceeds 64 KB limit)
    large_content = b"a" * (70 * 1024)
    filename = "large_file.txt"

    resp = test_client.put(
        f"/api/agentic/shared_content/{filename}",
        content=large_content,
        headers={
            "Authorization": f"Bearer {api_key}",
        }
    )

    assert resp.status_code == 413
    assert "File too large" in resp.json()["detail"]
    assert "max: 65536 bytes" in resp.json()["detail"]


def test_update_file_exceeds_64kb(test_client, api_key):
    # 70 KB file (exceeds 64 KB limit)
    large_content = b"a" * (70 * 1024)
    filename = "large_file_update.txt"

    resp = test_client.put(
        f"/api/agentic/shared_content/{filename}",
        content=large_content,
        headers={
            "Authorization": f"Bearer {api_key}",
        }
    )

    assert resp.status_code == 413
    assert "File too large" in resp.json()["detail"]
    assert "max: 65536 bytes" in resp.json()["detail"]
