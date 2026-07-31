"""Cloudflare R2 setup and provisioning helpers for ClawBitsServer."""
import logging
import os

from clawbits.cloudflare.r2_presign import R2Presigner
from clawbits.cloudflare.r2_provisioner import CloudflareR2Provisioner
from clawbits.cloudflare.r2_s3_client import R2S3Client


def setup_r2() -> tuple[CloudflareR2Provisioner | None, R2S3Client | None]:
    """Set up the R2 provisioner (control plane) and object client (data plane).

    These use *different* credentials on purpose:

    - the **provisioner** (create bucket + set CORS) talks the Cloudflare REST
      API with ``CLOUDFLARE_API_TOKEN`` — a rare bootstrap op;
    - the **client** (upload/download/list/delete) talks the S3 API with
      ``R2_ACCESS_KEY_ID`` / ``R2_SECRET_ACCESS_KEY`` — the data plane.

    Either may be None if its credentials are missing; the other still works.
    """
    provisioner: CloudflareR2Provisioner | None = None
    client: R2S3Client | None = None
    try:
        account_id = os.getenv("CLOUDFLARE_ACCOUNT_ID")
        api_token = os.getenv("CLOUDFLARE_API_TOKEN")

        # Control plane — only needed to provision buckets/CORS (skipped in dev).
        if account_id and api_token:
            provisioner = CloudflareR2Provisioner()
        else:
            logging.warning("⚠️ CLOUDFLARE_API_TOKEN not set - R2 provisioning disabled")

        # Data plane — S3 API. ``R2S3Client`` self-reports ``enabled``.
        s3 = R2S3Client()
        if s3.enabled:
            client = s3
            logging.info("✅ R2 initialized (REST provisioner + S3 client)")
        else:
            logging.warning(
                "⚠️ R2 S3 credentials not found (R2_ACCESS_KEY_ID / "
                "R2_SECRET_ACCESS_KEY) - R2 object I/O disabled"
            )
        return provisioner, client
    except Exception as e:
        logging.warning(f"⚠️ Failed to initialize R2: {e}")
        return provisioner, client


def setup_r2_presigner() -> R2Presigner | None:
    """Set up the S3-compatible presigner for direct browser uploads/downloads.

    Reads ``R2_ACCESS_KEY_ID`` / ``R2_SECRET_ACCESS_KEY`` from the env —
    these are *distinct* from ``CLOUDFLARE_API_TOKEN`` (REST API).

    The bucket comes from ``MM_FILES_BUCKET`` (chat-attachments specific)
    when set, falling back to ``CLOUDFLARE_BUCKET`` for legacy compat.
    Keeping them separate means agent-file-sharing (ShareRecord, on the
    legacy bucket) and chat attachments (on the dedicated
    ``clawbits-attachments-{env}`` bucket) don't share storage.

    Returns ``None`` if R2 access keys are missing; the chat-attachments
    endpoints degrade to ``503 Service Unavailable`` when that's the case.
    """
    try:
        bucket = os.getenv("MM_FILES_BUCKET") or None
        return R2Presigner(bucket=bucket) if bucket else R2Presigner()
    except ValueError as e:
        logging.warning(f"⚠️ R2 presigner disabled: {e}")
        return None
    except Exception as e:
        logging.warning(f"⚠️ Failed to initialize R2 presigner: {e}")
        return None


def setup_mm_files_r2_client() -> R2S3Client | None:
    """Set up the S3 data-plane client for the chat-attachments bucket.

    Serves the *direct* byte-upload route — runtimes whose HTTP egress
    can't reach a presigned R2 URL (the IronClaw WASM allowlist only
    permits the Clawbits API host) POST bytes to the API and the server
    performs the R2 PUT itself with this client.

    Bucket resolution matches :func:`setup_r2_presigner` — the
    ``MM_FILES_BUCKET`` chat-attachments bucket when set, falling back to
    the legacy ``CLOUDFLARE_BUCKET`` default inside :class:`R2S3Client`.
    Returns ``None`` when the S3 credentials are missing; the direct
    route degrades to ``503 Service Unavailable``, same contract as the
    presigner.
    """
    try:
        bucket = os.getenv("MM_FILES_BUCKET") or None
        client = R2S3Client(bucket=bucket) if bucket else R2S3Client()
        if not client.enabled:
            return None
        return client
    except Exception as e:
        logging.warning(f"⚠️ Failed to initialize mm-files R2 client: {e}")
        return None


async def provision_r2_on_startup(
    provisioner: CloudflareR2Provisioner | None,
    client: R2S3Client | None,
) -> tuple[CloudflareR2Provisioner | None, R2S3Client | None]:
    """Provision R2 resources on server startup.

    Returns the (provisioner, client) tuple — set to (None, None) if
    provisioning fails so the caller can update its references.

    ``provision_all`` is idempotent "ensure the bucket exists + CORS is
    set": ~5-6 sequential Cloudflare API round-trips that take several
    seconds. Buckets and CORS persist on Cloudflare's side, so in dev
    (where ``uvicorn --reload`` re-runs lifespan startup on every edit)
    this is pure overhead. ``CLAWBITS_SKIP_R2_PROVISION=1`` (set in
    ``.env.development``) skips it; the R2 *client* is untouched, so file
    upload/download/presign keep working against the existing buckets.
    Unset it to force a re-provision (fresh bucket, or a CORS change).
    """
    if os.environ.get("CLAWBITS_SKIP_R2_PROVISION") == "1":
        logging.info(
            "⏭️  Skipping R2 provisioning (CLAWBITS_SKIP_R2_PROVISION=1) — "
            "using existing buckets/CORS"
        )
        return provisioner, client

    if provisioner:
        try:
            logging.info("🚀 Starting Cloudflare R2 provisioning...")
            result = await provisioner.provision_all()
            logging.info(f"✅ R2 provisioning completed: {result}")

            # Apply the same CORS policy to the dedicated chat-attachments
            # bucket (if configured). Browser-side presigned PUTs need this
            # — the legacy ``CLOUDFLARE_BUCKET`` was already handled inside
            # ``provision_all`` above.
            mm_files_bucket = os.getenv("MM_FILES_BUCKET")
            if mm_files_bucket and mm_files_bucket != provisioner.bucket_name:
                cors_result = await provisioner.configure_cors_for(mm_files_bucket)
                logging.info(
                    f"✅ Attachments-bucket CORS step on '{mm_files_bucket}': {cors_result}"
                )

            # Test bucket access
            if client:
                test_result = await client.list_files("")
                if test_result.get("success"):
                    logging.info("✅ R2 bucket access test successful")
                else:
                    logging.warning(
                        f"⚠️ R2 bucket access test failed: {test_result.get('error')}"
                    )

        except Exception as e:
            logging.error(f"❌ R2 provisioning failed: {e}")
            # Don't fail server startup, just log the error
            return None, None

    return provisioner, client

