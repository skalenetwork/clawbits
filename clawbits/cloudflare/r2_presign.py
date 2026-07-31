"""AWS Sig V4 presigning for Cloudflare R2.

R2 exposes an S3-compatible API at
``https://{account_id}.r2.cloudflarestorage.com``. Presigned URLs use the
standard AWS Sig V4 query-string scheme — we generate them here without
pulling in boto3, since presigning is pure local computation.

Credentials are R2 Access Keys (created in the Cloudflare dashboard under
R2 → Manage R2 API Tokens → Create API token → S3 Compatibility), *not*
the ``CLOUDFLARE_API_TOKEN`` used by :mod:`clawbits.cloudflare.setup_r2`
for the REST API. Set ``R2_ACCESS_KEY_ID`` and ``R2_SECRET_ACCESS_KEY`` in
the env.

Two flavors are exposed:

- :func:`presign_put` — for direct browser uploads. Pins ``Content-Type``
  so the upload's MIME matches what the server authorized.
- :func:`presign_get` — for short-lived download URLs handed to the
  browser after a channel-membership authz check. Optionally pins
  ``response-content-disposition`` so the download shows the original
  filename.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
import os
from urllib.parse import quote, urlparse


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(secret: str, date_stamp: str, region: str, service: str) -> bytes:
    k_date = _hmac(f"AWS4{secret}".encode(), date_stamp)
    k_region = _hmac(k_date, region)
    k_service = _hmac(k_region, service)
    return _hmac(k_service, "aws4_request")


def _encode_query_value(v: str) -> str:
    # Per AWS Sig V4: every char except unreserved ALPHA / DIGIT / - _ . ~
    # is percent-encoded. ``quote(safe="")`` matches that set.
    return quote(v, safe="-_.~")


def _build_canonical_query(params: dict[str, str]) -> str:
    return "&".join(
        f"{_encode_query_value(k)}={_encode_query_value(v)}"
        for k, v in sorted(params.items())
    )


def _build_canonical_uri(bucket: str, key: str) -> str:
    # Each path segment gets URL-encoded, but slashes are preserved.
    encoded_key = "/".join(quote(seg, safe="-_.~") for seg in key.split("/"))
    return f"/{bucket}/{encoded_key}"


def _presign(
    *,
    method: str,
    endpoint: str,
    bucket: str,
    key: str,
    access_key_id: str,
    secret_access_key: str,
    region: str,
    expires: int,
    signed_headers: dict[str, str],
    extra_query: dict[str, str] | None = None,
    now: _dt.datetime | None = None,
) -> str:
    """Build a presigned URL using AWS Sig V4 query-string auth.

    ``signed_headers`` is the set of headers the client must send with the
    request — at minimum ``{"host": <endpoint_host>}``. Any header included
    here is canonicalized into the signature, so the client *must* send the
    same value or R2 will reject the request.
    """
    if now is None:
        now = _dt.datetime.now(_dt.UTC)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    service = "s3"

    host = urlparse(endpoint).netloc
    # Normalize: header names lower-cased for signing; host is mandatory.
    headers = {"host": host}
    headers.update({k.lower(): v for k, v in signed_headers.items()})
    signed_headers_str = ";".join(sorted(headers.keys()))
    canonical_headers = "".join(
        f"{k}:{headers[k].strip()}\n" for k in sorted(headers.keys())
    )

    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
    query: dict[str, str] = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{access_key_id}/{credential_scope}",
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(expires),
        "X-Amz-SignedHeaders": signed_headers_str,
    }
    if extra_query:
        query.update(extra_query)
    canonical_query = _build_canonical_query(query)

    canonical_uri = _build_canonical_uri(bucket, key)
    canonical_request = "\n".join([
        method.upper(),
        canonical_uri,
        canonical_query,
        canonical_headers,
        signed_headers_str,
        "UNSIGNED-PAYLOAD",
    ])

    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256",
        amz_date,
        credential_scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])

    signing_key = _signing_key(secret_access_key, date_stamp, region, service)
    signature = hmac.new(
        signing_key, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    return f"{endpoint}{canonical_uri}?{canonical_query}&X-Amz-Signature={signature}"


def sign_s3_request_headers(
    *,
    method: str,
    account_id: str,
    bucket: str,
    key: str = "",
    access_key_id: str,
    secret_access_key: str,
    region: str = "auto",
    payload: bytes = b"",
    extra_signed_headers: dict[str, str] | None = None,
    query_params: dict[str, str] | None = None,
    now: _dt.datetime | None = None,
) -> dict[str, str]:
    """AWS Sig V4 **header-auth** signing for a server-side R2 (S3) request.

    Companion to :func:`_presign` (which does query-string auth for
    browser URLs). Server-side calls send an ``Authorization`` header and
    the real payload hash, which is the standard SigV4 shape for a backend
    talking S3. Returns the headers to attach to the ``httpx`` request.

    ``key`` is the object key ("" for bucket-level ops like ListObjectsV2,
    where the canonical URI is just ``/{bucket}``). ``query_params`` are
    canonicalised into the signature (list-type / prefix / delimiter /
    max-keys). ``extra_signed_headers`` (e.g. ``content-type``,
    ``cache-control``) are folded into the signature *and* returned so the
    caller sends the identical values R2 will hash.
    """
    if now is None:
        now = _dt.datetime.now(_dt.UTC)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    service = "s3"
    host = urlparse(f"https://{account_id}.r2.cloudflarestorage.com").netloc
    payload_hash = hashlib.sha256(payload).hexdigest()

    # Host + the two mandatory x-amz-* headers are always signed; callers add
    # content-type / cache-control for PUTs.
    signed: dict[str, str] = {
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    if extra_signed_headers:
        signed.update({k.lower(): v for k, v in extra_signed_headers.items()})

    signed_header_names = ";".join(sorted(signed))
    canonical_headers = "".join(f"{k}:{signed[k].strip()}\n" for k in sorted(signed))
    canonical_query = _build_canonical_query(query_params or {})
    canonical_uri = _build_canonical_uri(bucket, key) if key else f"/{bucket}"
    canonical_request = "\n".join([
        method.upper(),
        canonical_uri,
        canonical_query,
        canonical_headers,
        signed_header_names,
        payload_hash,
    ])

    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256",
        amz_date,
        credential_scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])
    signing_key = _signing_key(secret_access_key, date_stamp, region, service)
    signature = hmac.new(
        signing_key, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    authorization = (
        f"AWS4-HMAC-SHA256 Credential={access_key_id}/{credential_scope}, "
        f"SignedHeaders={signed_header_names}, Signature={signature}"
    )
    out: dict[str, str] = {
        "Authorization": authorization,
        "x-amz-date": amz_date,
        "x-amz-content-sha256": payload_hash,
    }
    if extra_signed_headers:
        out.update(extra_signed_headers)
    return out


class R2Presigner:
    """Generates presigned PUT/GET URLs for the project's R2 bucket.

    Reads credentials from the env at construction time. Pure local
    computation — no I/O — so it can be instantiated once and shared.
    """

    def __init__(
        self,
        *,
        account_id: str | None = None,
        bucket: str | None = None,
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
        region: str = "auto",
    ) -> None:
        self.account_id = account_id or os.getenv("CLOUDFLARE_ACCOUNT_ID")
        self.bucket = bucket or os.getenv(
            "CLOUDFLARE_BUCKET", "clawbits-clawbits-storage"
        )
        self.access_key_id = access_key_id or os.getenv("R2_ACCESS_KEY_ID")
        self.secret_access_key = secret_access_key or os.getenv("R2_SECRET_ACCESS_KEY")
        self.region = region

        missing = [
            n
            for n, v in [
                ("CLOUDFLARE_ACCOUNT_ID", self.account_id),
                ("R2_ACCESS_KEY_ID", self.access_key_id),
                ("R2_SECRET_ACCESS_KEY", self.secret_access_key),
            ]
            if not v
        ]
        if missing:
            raise ValueError(
                f"R2Presigner is missing required env vars: {', '.join(missing)}"
            )

        self.endpoint = f"https://{self.account_id}.r2.cloudflarestorage.com"

    def presign_put(
        self,
        object_key: str,
        content_type: str,
        *,
        content_length: int,
        expires: int = 300,
    ) -> dict[str, str | dict[str, str]]:
        """Return a presigned URL the client should ``PUT`` raw bytes to.

        Signs both ``content-type`` and ``content-length`` — the browser's
        XHR sets ``Content-Length`` automatically from the actual blob
        size, so if the client tries to upload a different size than what
        the server authorized, R2 rejects the request. This closes the
        gap where a client could lie about ``size_bytes`` at presign time
        to bypass the server-side size cap.

        ``Content-Length`` isn't returned in the ``headers`` map because
        browsers refuse to let scripts set it manually — they always
        compute it from the body. The signature still pins the value.
        """
        signed_headers = {
            "content-type": content_type,
            "content-length": str(content_length),
        }
        url = _presign(
            method="PUT",
            endpoint=self.endpoint,
            bucket=self.bucket,
            key=object_key,
            access_key_id=self.access_key_id,
            secret_access_key=self.secret_access_key,
            region=self.region,
            expires=expires,
            signed_headers=signed_headers,
        )
        return {
            "url": url,
            "method": "PUT",
            "headers": {"Content-Type": content_type},
            "expires_in": expires,
        }

    def presign_get(
        self,
        object_key: str,
        *,
        expires: int = 3600,
        download_filename: str | None = None,
    ) -> dict[str, str | int]:
        """Return a presigned URL the client (or an ``<img>`` tag) can GET.

        If ``download_filename`` is supplied, the URL pins a
        ``response-content-disposition`` so the browser saves the file
        under the original name regardless of the R2 object key.
        """
        extra_query: dict[str, str] | None = None
        if download_filename:
            safe = download_filename.replace('"', "").replace("\\", "")
            extra_query = {
                "response-content-disposition": f'attachment; filename="{safe}"'
            }
        url = _presign(
            method="GET",
            endpoint=self.endpoint,
            bucket=self.bucket,
            key=object_key,
            access_key_id=self.access_key_id,
            secret_access_key=self.secret_access_key,
            region=self.region,
            expires=expires,
            signed_headers={},
            extra_query=extra_query,
        )
        return {"url": url, "expires_in": expires}
