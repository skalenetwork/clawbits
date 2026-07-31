"""Unit tests for the AWS Sig V4 presigner.

These don't touch R2 — they verify the algorithm produces URLs with the
expected structure and signing properties. The full proof is "R2 accepts
the upload"; that's covered by manual smoke testing in dev.
"""
from __future__ import annotations

import datetime as _dt
from urllib.parse import parse_qs, urlparse

from clawbits.cloudflare.r2_presign import R2Presigner, _presign


def _new_presigner() -> R2Presigner:
    return R2Presigner(
        account_id="acc123",
        bucket="my-bucket",
        access_key_id="AKIA_TEST",
        secret_access_key="secret_test",
    )


def test_presign_put_url_structure():
    p = _new_presigner()
    out = p.presign_put("hello/world.png", "image/png", content_length=2048)
    parsed = urlparse(out["url"])
    # Host is R2's S3-compat endpoint, derived from the account id.
    assert parsed.netloc == "acc123.r2.cloudflarestorage.com"
    # Path starts with /bucket/key.
    assert parsed.path == "/my-bucket/hello/world.png"
    q = parse_qs(parsed.query)
    assert q["X-Amz-Algorithm"] == ["AWS4-HMAC-SHA256"]
    assert q["X-Amz-Expires"] == ["300"]
    # Both content-type and content-length are signed — R2 rejects a PUT
    # whose actual body size doesn't match the signed value.
    assert q["X-Amz-SignedHeaders"] == ["content-length;content-type;host"]
    assert q["X-Amz-Credential"][0].startswith("AKIA_TEST/")
    assert "X-Amz-Signature" in q
    # Client must echo the Content-Type header — pinned at signature time.
    # Content-Length is also pinned by the signature, but browsers set it
    # automatically from the actual body and refuse to let scripts override.
    assert out["headers"]["Content-Type"] == "image/png"


def test_presign_put_signature_changes_with_content_length():
    """A client lying about size_bytes at presign time must produce a
    different signature — that's how the Content-Length pin survives."""
    p = _new_presigner()
    out_small = p.presign_put("k", "image/png", content_length=1024)
    out_big = p.presign_put("k", "image/png", content_length=100_000)
    sig_small = parse_qs(urlparse(out_small["url"]).query)["X-Amz-Signature"]
    sig_big = parse_qs(urlparse(out_big["url"]).query)["X-Amz-Signature"]
    assert sig_small != sig_big


def test_presign_get_url_structure():
    p = _new_presigner()
    out = p.presign_get("a/b.pdf", expires=900, download_filename="report.pdf")
    parsed = urlparse(out["url"])
    q = parse_qs(parsed.query)
    assert q["X-Amz-Algorithm"] == ["AWS4-HMAC-SHA256"]
    assert q["X-Amz-Expires"] == ["900"]
    # response-content-disposition is signed query param that R2 forwards
    # as the Content-Disposition response header on download.
    assert q["response-content-disposition"][0].startswith("attachment;")
    # GET doesn't pin content-type — only host is signed.
    assert q["X-Amz-SignedHeaders"] == ["host"]


def test_presign_is_deterministic_for_same_inputs():
    """Same inputs + same wall clock → same URL. Important for test stability."""
    now = _dt.datetime(2026, 5, 13, 18, 0, 0, tzinfo=_dt.UTC)
    url_a = _presign(
        method="PUT",
        endpoint="https://acc.r2.cloudflarestorage.com",
        bucket="b",
        key="k",
        access_key_id="ak",
        secret_access_key="sk",
        region="auto",
        expires=300,
        signed_headers={"content-type": "image/png"},
        now=now,
    )
    url_b = _presign(
        method="PUT",
        endpoint="https://acc.r2.cloudflarestorage.com",
        bucket="b",
        key="k",
        access_key_id="ak",
        secret_access_key="sk",
        region="auto",
        expires=300,
        signed_headers={"content-type": "image/png"},
        now=now,
    )
    assert url_a == url_b


def test_presign_signature_changes_with_method():
    now = _dt.datetime(2026, 5, 13, 18, 0, 0, tzinfo=_dt.UTC)
    put_url = _presign(
        method="PUT",
        endpoint="https://acc.r2.cloudflarestorage.com",
        bucket="b",
        key="k",
        access_key_id="ak",
        secret_access_key="sk",
        region="auto",
        expires=300,
        signed_headers={},
        now=now,
    )
    get_url = _presign(
        method="GET",
        endpoint="https://acc.r2.cloudflarestorage.com",
        bucket="b",
        key="k",
        access_key_id="ak",
        secret_access_key="sk",
        region="auto",
        expires=300,
        signed_headers={},
        now=now,
    )
    # Different method, same everything else → different signature.
    assert parse_qs(urlparse(put_url).query)["X-Amz-Signature"] != \
        parse_qs(urlparse(get_url).query)["X-Amz-Signature"]


def test_presign_signature_changes_with_secret():
    now = _dt.datetime(2026, 5, 13, 18, 0, 0, tzinfo=_dt.UTC)
    common = dict(
        method="PUT",
        endpoint="https://acc.r2.cloudflarestorage.com",
        bucket="b",
        key="k",
        access_key_id="ak",
        region="auto",
        expires=300,
        signed_headers={},
        now=now,
    )
    url_a = _presign(secret_access_key="sk_a", **common)
    url_b = _presign(secret_access_key="sk_b", **common)
    assert parse_qs(urlparse(url_a).query)["X-Amz-Signature"] != \
        parse_qs(urlparse(url_b).query)["X-Amz-Signature"]


def test_presign_key_with_special_chars_is_percent_encoded():
    p = _new_presigner()
    out = p.presign_get("mm/files/2026/05/abc/original/hello world.png")
    parsed = urlparse(out["url"])
    # Slashes are preserved as path separators; the space is encoded.
    assert "hello%20world.png" in parsed.path
