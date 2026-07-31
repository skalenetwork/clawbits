"""S3-compatible R2 client for server-side object I/O.

Talks to R2's **S3 API** (``https://{account}.r2.cloudflarestorage.com``)
with AWS Sig V4 instead of the Cloudflare REST API. Same method names and
return shapes, so existing callers (avatars, agent file-sharing) are unchanged.

Why: the S3 API is the recommended data plane for R2 — credentials are
bucket-scopable R2 access keys (``R2_ACCESS_KEY_ID`` / ``R2_SECRET_ACCESS_KEY``,
created under R2 → Manage R2 API Tokens → S3 Compatibility), least-privilege
and portable, unlike the account-wide ``CLOUDFLARE_API_TOKEN`` Bearer token the
REST client uses. Bucket *provisioning* (create + CORS) stays on the REST
:class:`CloudflareR2Provisioner`; that's a rare bootstrap op, not a data-plane one.

No boto3 — the Sig V4 signing reuses the hand-rolled primitives in
:mod:`clawbits.cloudflare.r2_presign` (same choice the presigner already made).
"""
from __future__ import annotations

import hashlib
import logging
import os
import xml.etree.ElementTree as ET
from typing import Any

import httpx

from clawbits.cloudflare.r2_presign import (
    _build_canonical_query,
    _build_canonical_uri,
    sign_s3_request_headers,
)
from clawbits.domain import SHARE_DOMAIN

logger = logging.getLogger(__name__)

# R2's S3 endpoint always signs with region "auto".
_REGION = "auto"


def _localname(tag: str) -> str:
    """Strip the ``{namespace}`` prefix ElementTree prepends to tag names."""
    return tag.rsplit("}", 1)[-1]


class R2S3Client:
    """S3-API R2 client for server-side object I/O.

    ``bucket`` / ``custom_domain`` play the same role as on the REST client
    (per-subsystem bucket + public URL host). Credentials come from the env
    (``CLOUDFLARE_ACCOUNT_ID`` + ``R2_ACCESS_KEY_ID`` / ``R2_SECRET_ACCESS_KEY``);
    ``enabled`` is False when any is missing, and every method short-circuits
    to a not-configured error — same degradation contract as the REST client.
    """

    def __init__(
        self,
        *,
        bucket: str | None = None,
        custom_domain: str | None = None,
        account_id: str | None = None,
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
    ) -> None:
        self.account_id = account_id or os.getenv("CLOUDFLARE_ACCOUNT_ID")
        self.access_key_id = access_key_id or os.getenv("R2_ACCESS_KEY_ID")
        self.secret_access_key = secret_access_key or os.getenv("R2_SECRET_ACCESS_KEY")
        self.bucket_name = bucket or os.getenv("CLOUDFLARE_BUCKET", "clawbits-clawbits-storage")
        self.custom_domain = custom_domain or SHARE_DOMAIN

        self.enabled = bool(self.account_id and self.access_key_id and self.secret_access_key)
        if not self.enabled:
            logger.warning(
                "R2 S3 credentials not set (CLOUDFLARE_ACCOUNT_ID + "
                "R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY); R2 operations will be skipped."
            )
        self.endpoint = f"https://{self.account_id}.r2.cloudflarestorage.com"

    # --- helpers -----------------------------------------------------------

    def _sanitize_key(self, key: str) -> str:
        # Block path traversal + leading slashes. NB: no percent-encoding here —
        # that happens once, inside ``_build_canonical_uri`` (and the request URL
        # is built from the same helper), so signature and path can't diverge.
        return key.replace("../", "").replace("..\\", "").lstrip("/\\")

    def _object_url(self, object_key: str) -> str:
        """Public URL for an object (custom domain if set, else the S3 path)."""
        if self.custom_domain:
            return f"https://{self.custom_domain}/{object_key}"
        return f"{self.endpoint}/{self.bucket_name}/{object_key}"

    def _request_url(self, key: str = "", query: str = "") -> str:
        """Build the request URL from the *same* canonical path the signer uses."""
        path = _build_canonical_uri(self.bucket_name, key) if key else f"/{self.bucket_name}"
        return f"{self.endpoint}{path}{('?' + query) if query else ''}"

    def _sign(
        self,
        method: str,
        key: str,
        *,
        payload: bytes = b"",
        extra_signed_headers: dict[str, str] | None = None,
        query_params: dict[str, str] | None = None,
    ) -> dict[str, str]:
        return sign_s3_request_headers(
            method=method,
            account_id=self.account_id or "",
            bucket=self.bucket_name,
            key=key,
            access_key_id=self.access_key_id or "",
            secret_access_key=self.secret_access_key or "",
            region=_REGION,
            payload=payload,
            extra_signed_headers=extra_signed_headers,
            query_params=query_params,
        )

    # --- data-plane ops ----------------------------------------------------

    async def upload_file(
        self,
        object_key: str,
        content: bytes,
        content_type: str = "application/octet-stream",
        *,
        cache_control: str | None = None,
    ) -> dict[str, Any]:
        if not self.enabled:
            return {"success": False, "error": "Cloudflare R2 is not configured"}
        key = self._sanitize_key(object_key)
        content_hash = hashlib.sha256(content).hexdigest()
        signed_headers: dict[str, str] = {"content-type": content_type}
        if cache_control:
            signed_headers["cache-control"] = cache_control
        headers = self._sign("PUT", key, payload=content, extra_signed_headers=signed_headers)
        async with httpx.AsyncClient(timeout=60.0) as client:
            try:
                resp = await client.put(self._request_url(key), content=content, headers=headers)
                resp.raise_for_status()
                logger.info(f"✅ Uploaded file (S3): {key} ({len(content)} bytes)")
                return {
                    "success": True,
                    "object_key": key,
                    "url": self._object_url(key),
                    "size": len(content),
                    "content_type": content_type,
                    "hash": content_hash,
                    "bucket": self.bucket_name,
                }
            except httpx.HTTPStatusError as e:
                logger.error(f"❌ Upload failed (S3) for {key}: {e.response.text[:300]}")
                return {
                    "success": False,
                    "error": f"Upload failed: {e.response.status_code}",
                    "details": e.response.text[:500],
                }
            except Exception as e:
                logger.error(f"❌ Upload error (S3) for {key}: {e}")
                return {"success": False, "error": str(e)}

    async def download_file(self, object_key: str) -> tuple[bool, bytes | str]:
        if not self.enabled:
            return False, "Cloudflare R2 is not configured"
        key = self._sanitize_key(object_key)
        headers = self._sign("GET", key)
        async with httpx.AsyncClient(timeout=60.0) as client:
            try:
                resp = await client.get(self._request_url(key), headers=headers)
                resp.raise_for_status()
                return True, resp.content
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404:
                    logger.warning(f"⚠️ File not found (S3): {key}")
                    return False, "File not found"
                logger.error(f"❌ Download failed (S3) for {key}: {e.response.text[:300]}")
                return False, f"Download failed: {e.response.status_code}"
            except Exception as e:
                logger.error(f"❌ Download error (S3) for {key}: {e}")
                return False, str(e)

    async def get_file_info(self, object_key: str) -> dict[str, Any]:
        if not self.enabled:
            return {"success": False, "error": "Cloudflare R2 is not configured"}
        key = self._sanitize_key(object_key)
        headers = self._sign("HEAD", key)
        async with httpx.AsyncClient(timeout=30.0) as client:
            try:
                resp = await client.head(self._request_url(key), headers=headers)
                resp.raise_for_status()
                return {
                    "success": True,
                    "object_key": key,
                    "url": self._object_url(key),
                    "content_type": resp.headers.get("Content-Type"),
                    "content_length": int(resp.headers.get("Content-Length", 0)),
                    "last_modified": resp.headers.get("Last-Modified"),
                    "etag": resp.headers.get("ETag", "").strip('"'),
                }
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404:
                    return {"success": False, "error": "File not found", "object_key": key}
                logger.error(f"❌ File info failed (S3) for {key}: {e.response.status_code}")
                return {"success": False, "error": f"Request failed: {e.response.status_code}"}
            except Exception as e:
                logger.error(f"❌ File info error (S3) for {key}: {e}")
                return {"success": False, "error": str(e)}

    async def delete_file(self, object_key: str) -> dict[str, Any]:
        if not self.enabled:
            return {"success": False, "error": "Cloudflare R2 is not configured"}
        key = self._sanitize_key(object_key)
        headers = self._sign("DELETE", key)
        async with httpx.AsyncClient(timeout=30.0) as client:
            try:
                resp = await client.delete(self._request_url(key), headers=headers)
                if resp.status_code == 404:
                    return {"success": False, "error": "File not found", "object_key": key}
                resp.raise_for_status()
                logger.info(f"✅ Deleted file (S3): {key}")
                return {
                    "success": True,
                    "object_key": key,
                    "message": "File deleted successfully",
                }
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404:
                    return {"success": False, "error": "File not found", "object_key": key}
                logger.error(f"❌ Delete failed (S3) for {key}: {e.response.text[:300]}")
                return {
                    "success": False,
                    "error": f"Delete failed: {e.response.status_code}",
                    "details": e.response.text[:500],
                }
            except Exception as e:
                logger.error(f"❌ Delete error (S3) for {key}: {e}")
                return {"success": False, "error": str(e)}

    async def list_files(self, prefix: str = "") -> dict[str, Any]:
        if not self.enabled:
            return {"success": False, "error": "Cloudflare R2 is not configured"}
        prefix = self._sanitize_key(prefix) if prefix else ""
        # delimiter="/" makes R2 fold nested keys into CommonPrefixes so we get
        # the files at this level + subdirectory names, matching the REST client.
        params: dict[str, str] = {"list-type": "2", "delimiter": "/"}
        if prefix:
            params["prefix"] = prefix
        query = _build_canonical_query(params)
        headers = self._sign("GET", "", query_params=params)
        async with httpx.AsyncClient(timeout=30.0) as client:
            try:
                resp = await client.get(self._request_url("", query), headers=headers)
                resp.raise_for_status()
            except httpx.HTTPStatusError as e:
                logger.error(f"❌ List failed (S3) for '{prefix}': {e.response.text[:300]}")
                return {"success": False, "error": f"List failed: {e.response.status_code}"}
            except Exception as e:
                logger.error(f"❌ List error (S3) for '{prefix}': {e}")
                return {"success": False, "error": str(e)}

        files: list[dict[str, Any]] = []
        subdirectories: list[str] = []
        try:
            root = ET.fromstring(resp.text)
        except ET.ParseError as e:
            return {"success": False, "error": f"List parse error: {e}"}
        for el in root:
            ln = _localname(el.tag)
            if ln == "Contents":
                fields = {_localname(c.tag): (c.text or "") for c in el}
                key = fields.get("Key", "")
                if not key or key == prefix:
                    continue
                name = key[len(prefix):] if prefix and key.startswith(prefix) else key
                files.append({
                    "name": name,
                    "key": key,
                    "size": int(fields.get("Size") or 0),
                    "last_modified": fields.get("LastModified", ""),
                    "url": self._object_url(key),
                })
            elif ln == "CommonPrefixes":
                cp = next((c.text for c in el if _localname(c.tag) == "Prefix" and c.text), None)
                if cp:
                    sub = (cp[len(prefix):] if prefix and cp.startswith(prefix) else cp).rstrip("/")
                    if sub:
                        subdirectories.append(sub)
        return {
            "success": True,
            "prefix": prefix,
            "files": files,
            "subdirectories": subdirectories,
            "total_objects": len(files) + len(subdirectories),
            "total_files": len(files),
            "total_subdirectories": len(subdirectories),
        }

    async def check_access(self) -> dict[str, Any]:
        """Cheapest authenticated op — ListObjectsV2 capped at one key.

        Used by the startup health check so a bad/missing R2 access key
        surfaces loudly instead of silently degrading every upload.
        """
        if not self.enabled:
            return {"success": False, "error": "R2 S3 credentials not configured"}
        params = {"list-type": "2", "max-keys": "1"}
        query = _build_canonical_query(params)
        headers = self._sign("GET", "", query_params=params)
        async with httpx.AsyncClient(timeout=15.0) as client:
            try:
                resp = await client.get(self._request_url("", query), headers=headers)
                resp.raise_for_status()
                return {"success": True, "bucket": self.bucket_name}
            except httpx.HTTPStatusError as e:
                return {
                    "success": False,
                    "status": e.response.status_code,
                    "error": e.response.text[:200],
                }
            except Exception as e:
                return {"success": False, "error": str(e)}
