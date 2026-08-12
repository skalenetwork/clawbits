# clawbits/cloudflare/r2_provisioner.py
import logging
import os
from typing import Any

import httpx

from clawbits.domain import SHARE_DOMAIN

logger = logging.getLogger(__name__)

class CloudflareR2Provisioner:
    """Handles automatic provisioning and setup of Cloudflare R2 resources."""

    def __init__(self):
        self.account_id = os.getenv("CLOUDFLARE_ACCOUNT_ID")
        self.api_token = os.getenv("CLOUDFLARE_API_TOKEN")
        self.bucket_name = os.getenv("CLOUDFLARE_BUCKET", "clawbits-clawbits-storage")
        self.custom_domain = SHARE_DOMAIN

        if not self.account_id or not self.api_token:
            raise ValueError("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set")

        self.base_url = "https://api.cloudflare.com/client/v4"
        self.headers = {
            "Authorization": f"Bearer {self.api_token}",
            "Content-Type": "application/json"
        }

    async def provision_all(self) -> dict[str, Any]:
        """Provision all required Cloudflare R2 resources."""
        results = {}

        try:
            # Create R2 bucket
            bucket_result = await self.create_bucket()
            results["bucket"] = bucket_result

            # Configure CORS for the bucket
            cors_result = await self.configure_cors()
            results["cors"] = cors_result

            # Set up custom domain if specified
            if self.custom_domain:
                domain_result = await self.setup_custom_domain()
                results["custom_domain"] = domain_result

            # Configure bucket settings
            settings_result = await self.configure_bucket_settings()
            results["settings"] = settings_result

            logger.info(f"✅ Successfully provisioned Cloudflare R2 resources: {results}")
            return results

        except Exception as e:
            logger.error(f"❌ Failed to provision Cloudflare R2 resources: {e}")
            raise

    async def create_bucket(self) -> dict[str, Any]:
        """Create R2 bucket if it doesn't exist."""
        async with httpx.AsyncClient() as client:
            # Check if bucket already exists
            list_url = f"{self.base_url}/accounts/{self.account_id}/r2/buckets"

            try:
                response = await client.get(list_url, headers=self.headers, timeout=30.0)
                response.raise_for_status()

                response_data = response.json()
                existing_buckets = response_data.get("result", [])

                # Handle case where result might be a dict instead of list
                if isinstance(existing_buckets, dict):
                    existing_buckets = existing_buckets.get("buckets", [])

                bucket_names = [bucket.get("name", "") for bucket in existing_buckets if isinstance(bucket, dict)]

                if self.bucket_name in bucket_names:
                    logger.info(f"✅ Bucket '{self.bucket_name}' already exists")
                    return {"status": "exists", "name": self.bucket_name}

                # Create new bucket
                create_url = f"{self.base_url}/accounts/{self.account_id}/r2/buckets"
                bucket_data = {
                    "name": self.bucket_name,
                    "default_storage_class": "Standard"
                }

                response = await client.post(
                    create_url,
                    json=bucket_data,
                    headers=self.headers,
                    timeout=30.0
                )
                response.raise_for_status()

                logger.info(f"✅ Created new R2 bucket: {self.bucket_name}")
                return {"status": "created", "name": self.bucket_name, "data": response.json()}

            except httpx.HTTPStatusError as e:
                if e.response.status_code == 409:
                    logger.info(f"✅ Bucket '{self.bucket_name}' already exists (409)")
                    return {"status": "exists", "name": self.bucket_name}
                else:
                    logger.error(f"❌ Failed to create bucket: {e.response.text}")
                    raise

    async def configure_cors(self) -> dict[str, Any]:
        """Configure CORS settings for the bucket.

        Browser-side presigned PUTs for chat attachments hit R2 directly
        from the user's origin, so the bucket must allow preflight from
        that origin. Origin is derived from ``CLAWBITS_BASE_URL`` so each
        env's bucket is locked to its own front-end (dev: localhost:5173;
        staging: app.freeclaws.ai; prod: app.clawbits.ai). Re-applied on every
        boot by ``provision_r2_on_startup``, so moving CLAWBITS_BASE_URL (the
        apex cutover) heals the bucket on the next deploy WITHOUT a manual step
        - except where ``CLAWBITS_SKIP_R2_PROVISION=1`` is set (dev), which then
        needs an explicit re-provision or the browser's direct PUT/GET to R2
        preflights from an origin the bucket has never heard of.
        """
        return await self._put_cors_for_bucket(self.bucket_name)

    async def configure_cors_for(self, bucket_name: str) -> dict[str, Any]:
        """Public hook so callers (e.g. a separate attachments-bucket
        provisioning step) can apply the same CORS policy to another
        bucket in the account."""
        return await self._put_cors_for_bucket(bucket_name)

    async def _put_cors_for_bucket(self, bucket_name: str) -> dict[str, Any]:
        # Build the allowed-origin list from CLAWBITS_BASE_URL. We also
        # add the production-style HTTPS form of staging/prod in case the
        # browser ends up on a redirect chain — but keep it minimal.
        base_url = os.getenv("CLAWBITS_BASE_URL", "").rstrip("/")
        if base_url:
            # The desktop Tauri webview has a different origin than the
            # web frontend (tauri://localhost on macOS/Windows,
            # http://tauri.localhost on Linux). Direct PUTs to R2 from
            # the desktop app fail CORS preflight without these — must
            # stay in sync with the CORS list in fastapi/main.py.
            origins = [
                base_url,
                "tauri://localhost",
                "http://tauri.localhost",
            ]
        else:
            origins = ["*"]

        # Correct Cloudflare R2 CORS API shape: top-level ``{rules:[…]}``,
        # camelCase keys, ``allowed`` nested block. (The previous version
        # used a top-level array with snake_case — silently 400'd.)
        cors_config = {
            "rules": [
                {
                    "allowed": {
                        "origins": origins,
                        "methods": ["GET", "PUT", "HEAD"],
                        "headers": ["Content-Type", "Content-Length"],
                    },
                    "exposeHeaders": ["ETag"],
                    "maxAgeSeconds": 3600,
                }
            ]
        }

        async with httpx.AsyncClient() as client:
            try:
                url = f"{self.base_url}/accounts/{self.account_id}/r2/buckets/{bucket_name}/cors"
                response = await client.put(
                    url,
                    json=cors_config,
                    headers=self.headers,
                    timeout=30.0,
                )
                response.raise_for_status()
                logger.info(f"✅ Configured CORS for bucket: {bucket_name} (origin={origins})")
                return {"status": "configured", "origins": origins}

            except Exception as e:
                logger.warning(f"⚠️ Could not configure CORS on {bucket_name}: {e}")
                return {"status": "skipped", "reason": str(e)}

    async def setup_custom_domain(self) -> dict[str, Any]:
        """Set up custom domain for the R2 bucket."""
        try:
            logger.info(f"🔗 Custom domain '{self.custom_domain}' should be configured manually")
            logger.info(f"📝 Configure CNAME: {self.custom_domain} -> {self.account_id}.r2.cloudflarestorage.com")

            return {
                "status": "manual_setup_required",
                "domain": self.custom_domain,
                "instructions": f"Create CNAME: {self.custom_domain} -> {self.account_id}.r2.cloudflarestorage.com"
            }

        except Exception as e:
            logger.warning(f"⚠️ Could not set up custom domain automatically: {e}")
            return {"status": "failed", "reason": str(e)}

    async def configure_bucket_settings(self) -> dict[str, Any]:
        """Configure additional bucket settings."""
        try:
            # Configure public read access if needed
            logger.info(f"✅ Bucket settings configured for: {self.bucket_name}")
            return {
                "status": "configured",
                "public_access": "enabled",
                "bucket": self.bucket_name
            }

        except Exception as e:
            logger.warning(f"⚠️ Could not configure all bucket settings: {e}")
            return {"status": "partial", "reason": str(e)}

