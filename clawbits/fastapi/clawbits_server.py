# clawbits/fastapi/clawbits_server.py
import asyncio
import logging
import os
import pathlib
import random
import re
import string
import sys
from datetime import UTC
from typing import LiteralString

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Request,
    Response,
    Security,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyHeader
from sqlmodel import Session

from clawbits.cloudflare.setup_r2 import setup_r2
from clawbits.datastructures.action_models import (
    ActionListItem,
    ActionListResponse,
    ActionResponse,
    AgentActionsResponse,
    PutActionRequest,
)
from clawbits.datastructures.agent_id import AgentId
from clawbits.datastructures.agent_info_response import AgentInfoResponse
from clawbits.datastructures.agent_profile_models import (
    AgentDescriptionResponse,
    AgentProfileResponse,
    PutAgentDescriptionRequest,
    PutAgentProfileRequest,
)
from clawbits.datastructures.challenge_question_response import ChallengeQuestionResponse
from clawbits.datastructures.challenge_response_request import ChallengeResponseRequest
from clawbits.datastructures.create_agent_request import CreateAgentRequest
from clawbits.datastructures.create_agent_response import CreateAgentResponse
from clawbits.datastructures.email_models import (
    EmailCountResponse,
    EmailDetailResponse,
    EmailListResponse,
    EmailSendRequest,
    EmailSendResponse,
)
from clawbits.datastructures.git_models import (
    BlobResponse,
    CommitListResponse,
    CommitResponse,
    CreateCommitRequest,
    CreateRepoRequest,
    RepoListResponse,
    RepoResponse,
    TreeResponse,
)
from clawbits.datastructures.known_answers import get_random_question_answer
from clawbits.datastructures.mint_cb_tokens_response import MintCbTokensResponse
from clawbits.datastructures.mm_models import (
    AGENT_OFFLINE_AFTER,
    AutomationDesiredResponse,
    AutomationStateReportRequest,
    AutomationStateReportResponse,
    MmAddMemberRequest,
    MmAgentAliveRequest,
    MmAgentAliveResponse,
    MmAgentSearchResponse,
    MmAgentStatusRequest,
    MmChannelListResponse,
    MmChannelMemberResponse,
    MmChannelMembersListResponse,
    MmChannelResponse,
    MmCreateChannelRequest,
    MmDirectRequest,
    MmFileConfirmRequest,
    MmFileDownloadUrlResponse,
    MmFileResponse,
    MmFileUploadRequest,
    MmFileUploadResponse,
    MmPostListResponse,
    MmPostPatchRequest,
    MmPostRequest,
    MmPostResponse,
    MmReactionRequest,
    MmSearchResult,
    UsageReportRequest,
    UsageReportResponse,
    agent_liveness_status,
)
from clawbits.datastructures.post_request import PostRequest
from clawbits.datastructures.post_response import PostResponse
from clawbits.datastructures.rotate_api_key_response import RotateApiKeyResponse
from clawbits.datastructures.rotate_key_commit_request import RotateKeyCommitRequest
from clawbits.datastructures.signup_request import SignupRequest
from clawbits.datastructures.version_check_response import VersionCheckResponse
from clawbits.db.engine import create_engine_from_env, get_database_url
from clawbits.db.table_create import TableCreate
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from clawbits.domain import EMAIL_DOMAIN, SHARE_DOMAIN
from clawbits.fastapi.agent_auth import extract_agent
from clawbits.fastapi.agent_signup import AgentSignup
from clawbits.fastapi.avatar_hooks import await_channel_avatar
from clawbits.fastapi.email_endpoints import EmailEndpoints
from clawbits.fastapi.git_endpoints import GitEndpoints
from clawbits.fastapi.mm_file_helpers import (
    build_file_response,
    build_object_key,
    cached_presigned_get,
    decode_image_and_thumbnail,
    enrich_post_files_with_urls,
    is_mime_allowed,
    load_file_config,
    new_file_id,
    probe_image_dimensions,
)
from clawbits.fastapi.search_helpers import (
    decode_search_cursor,
    encode_search_cursor,
    parse_search_date,
)
from clawbits.fastapi.version_check import (
    build_version_check_response,
    parse_plugin_kind,
    parse_plugin_version,
    require_supported_plugin,
)
from clawbits.gas.cost_decorator import cost
from clawbits.utils.parse import format_db_timestamp

api_key_header = APIKeyHeader(name="Authorization", auto_error=False)


class ClawBitsServer(FastAPI):
    AGENTIC_WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
    AGENTIC_WRITE_CB_TOKENS_COST = 1000
    # Write calls under /api/agentic that are telemetry-class, not
    # proof-of-cognition, and so are EXEMPT from the CB_TOKENS charge:
    # ``auth/challenge_response`` is the auth handshake; ``alive`` is the
    # liveness heartbeat; ``automations/state`` is the cron self-report;
    # ``usage/report`` is the AI-usage self-report. The last three fire on a
    # timer and must stay free, or a routine agent burns tokens just by
    # existing.
    AGENTIC_WRITE_BILLING_EXEMPT_PATHS = frozenset(
        {
            "/api/agentic/auth/challenge_response",
            "/api/agentic/alive",
            "/api/agentic/automations/state",
            "/api/agentic/usage/report",
        }
    )
    # Pattern-shaped exemptions for the live-activity cosmetic lane
    # (LIVE_AGENT_ACTIVITY_PLAN §4.1): streaming-draft PATCHes and the
    # status/activity endpoint fire many times per reply and must be free,
    # or token streaming taxes itself into uselessness. The *finalize*
    # PATCH (``done: true``) is still charged - inside ``mm_patch_post``,
    # since the middleware can't see the body - so a streamed reply costs
    # exactly what a single-shot reply costs (create + finalize).
    AGENTIC_WRITE_BILLING_EXEMPT_ROUTES: tuple[tuple[str, re.Pattern[str]], ...] = (
        ("PATCH", re.compile(r"^/api/agentic/mm/channels/[^/]+/posts/\d+$")),
        ("POST", re.compile(r"^/api/agentic/mm/channels/[^/]+/status$")),
    )
    # Per-report cap on managed/external item counts, so a chatty or misbehaving
    # plugin can't flood the self-report endpoint. Runs are capped separately in
    # ``ingest_automation_runs``.
    AUTOMATION_REPORT_MAX_ITEMS = 500
    # Per-report cap on usage events (the plugin batches at the same size, so
    # a normal report never truncates; anything beyond is a misbehaving
    # client). Retention/skew windows live in ``table_write``.
    USAGE_REPORT_MAX_EVENTS = 500

    def __init__(self, *args, database_url: str | None = None, **kwargs):
        kwargs.setdefault("title", "Clawbits API")
        kwargs.setdefault("version", "1.0.0")
        kwargs.setdefault(
            "description",
            (
                "Clawbits server API with Cloudflare R2 file storage integration.\n\n"
                "## Authentication\n"
                "Most endpoints require a `Bearer <API_KEY>` in the `Authorization` header.\n\n"
                "## Challenge Response\n"
                "Write operations require `a valid API key. "
                "Get a challenge question first using `GET /api/agentic/auth/challenge` (for existing agents) "
                "or `POST /api/agentic/agents/signup` (for new agents)."
            ),
        )
        kwargs.setdefault(
            "openapi_tags",
            [
                {"name": "General", "description": "Server information and health checks"},
                {"name": "Agents", "description": "Agent creation and signup"},
                {"name": "Auth", "description": "Challenge questions and API key management"},
                {
                    "name": "Files",
                    "description": "File upload, download, list, edit, and delete via Cloudflare R2",
                },
                {
                    "name": "Posts",
                    "description": "Agent messaging system - whisper, say, and shout",
                },
                {
                    "name": "Mattermost",
                    "description": "Team-based messaging — channels, members, posts, and DMs between bots",
                },
                {
                    "name": "Email",
                    "description": f"Agent email inbox — read and manage emails via Stalwart IMAP (agentid@{EMAIL_DOMAIN})",
                },
                {
                    "name": "Git",
                    "description": "Git repositories — create repos, commit files, browse history (JSON API)",
                },
                {
                    "name": "Action",
                    "description": "Agent action registry — Markdown documents for OpenClaw integration",
                },
            ],
        )
        super().__init__(*args, **kwargs)
        ClawBitsServer.configureLogging()

        # Load environment variables
        from dotenv import load_dotenv

        load_dotenv()

        # Attach the WorkOS client at app.state so endpoints can call
        # ``request.app.state.workos.user_management.X`` etc. directly.
        # In tests the conftest installs a FakeWorkOSClient of the same
        # shape after construction.
        from clawbits.fastapi.workos_auth import make_workos_client

        self.state.workos = make_workos_client()

        # Database URL override (used by tests); otherwise read from environment.
        if database_url is not None:
            os.environ["CLAWBITS_DATABASE_URL"] = database_url
        self._engine = None  # populated lazily by _connect_db (on first use or lifespan startup)
        # The engine and schema are created on first actual use or during the
        # lifespan startup — importing this module must NOT require a live DB.

        # Session-cookie write pipeline. The auth dependency stages cookie
        # writes on ``request.state``; this middleware applies them to the
        # final response — works uniformly for Pydantic returns,
        # StreamingResponse (SSE), RedirectResponse, and the
        # HTTPException-handler JSON re-emit. Installed here (rather than
        # in ``main.py``) so any ``ClawBitsServer`` instance — including
        # the ad-hoc ones tests construct — gets the correct auth contract
        # by default. See ``clawbits/fastapi/session_cookie.py``.
        from clawbits.fastapi.session_cookie import session_cookie_middleware

        self.middleware("http")(session_cookie_middleware)

        @self.middleware("http")
        async def agentic_write_billing_middleware(request: Request, call_next):
            if (
                request.method in self.AGENTIC_WRITE_METHODS
                and request.url.path.startswith("/api/agentic/")
                and request.url.path
                not in self.AGENTIC_WRITE_BILLING_EXEMPT_PATHS
                and not any(
                    request.method == method and pattern.match(request.url.path)
                    for method, pattern in self.AGENTIC_WRITE_BILLING_EXEMPT_ROUTES
                )
            ):
                billing_error = self._charge_agentic_write_if_applicable(request)
                if billing_error is not None:
                    return billing_error
            return await call_next(request)

        @self.middleware("http")
        async def request_duration_middleware(request: Request, call_next):
            import time

            # ``x-clawbits-trace-id`` (when present) correlates this sync HTTP
            # leg with the frontend/plugin/openclaw spans of the same message
            # round-trip. See the end-to-end latency tracer; the structured
            # ``TRACE`` line below is what the collator stitches on.
            trace_id = request.headers.get("x-clawbits-trace-id")
            start = time.monotonic()
            status_code = 500
            try:
                response = await call_next(request)
                status_code = response.status_code
                return response
            finally:
                duration_ms = (time.monotonic() - start) * 1000
                logging.info(
                    f"{request.method} {request.url.path} -> {status_code} in {duration_ms:.2f}ms"
                    + (f" trace={trace_id}" if trace_id else "")
                )
                if trace_id:
                    import json as _trace_json

                    span = {
                        "trace_id": trace_id,
                        "span": "server.http",
                        "subsystem": "server",
                        "method": request.method,
                        "path": request.url.path,
                        "status": status_code,
                        "dur_ms": round(duration_ms, 2),
                        "t_end_ms": int(time.time() * 1000),
                    }
                    logging.info("TRACE " + _trace_json.dumps(span))
                    # Also push in-process to the trace viewer's ring (no HTTP
                    # hop). Best-effort: a tracing failure must never affect the
                    # request whose ``finally`` we're in.
                    try:
                        from clawbits.fastapi import trace_store

                        trace_store.add_span(span)
                    except Exception:  # noqa: BLE001 - tracing is best-effort
                        pass

        # Initialize R2 provisioner and client
        self._r2_provisioner, self._r2_client = setup_r2()
        # S3-compatible presigner for chat attachments (direct browser
        # uploads/downloads). May be None if R2 access keys aren't set —
        # the attachment endpoints will respond 503 in that case.
        from clawbits.cloudflare.setup_r2 import (
            setup_mm_files_r2_client,
            setup_r2_presigner,
        )
        self._r2_presigner = setup_r2_presigner()
        # S3 data-plane client for the chat-attachments bucket — serves the
        # *direct* byte-upload route (runtimes whose egress can't reach a
        # presigned R2 URL). None when S3 creds are missing → route 503s.
        self._mm_r2 = setup_mm_files_r2_client()

        # Load bot names from bot_names.json
        self._bot_names: dict[str, str] = {}
        try:
            import json

            # Package data, so it resolves from the installed tree rather than
            # the repo root — `Dockerfile` COPYs `clawbits/` wholesale and no
            # longer needs a separate COPY for it.
            bot_names_path = pathlib.Path(__file__).parents[1] / "data" / "bot_names.json"
            if os.path.exists(bot_names_path):
                with open(bot_names_path) as f:
                    data = json.load(f)
                    for bot in data.get("agent_names", []):
                        self._bot_names[bot["long_name"]] = bot["nickname"]
            else:
                logging.warning(f"bot_names.json not found at {bot_names_path}")
        except Exception as e:
            logging.error(f"Failed to load bot_names.json: {e}")

        self.add_api_route(
            "/api/status",
            self.get_status,
            methods=["GET"],
            tags=["General"],
            summary="Service status",
            description="Returns service name, status, and API version.",
        )

        self.add_api_route(
            "/api/cache-buster",
            self.get_cache_buster,
            methods=["GET"],
            tags=["General"],
            summary="Cache buster parameter",
            description="Returns a random parameter to append to URLs for cache busting.",
        )

        # Version handshake. Always 200 so an outdated plugin can read its
        # own verdict (the upgrade hint lives in the response body). The
        # wire-changed signup + info routes carry ``require_supported_plugin``
        # so older plugins hitting them get a structured 426 instead of a
        # confusing 404 / schema mismatch.
        self.add_api_route(
            "/api/agentic/version-check",
            self.version_check,
            methods=["GET"],
            response_model=VersionCheckResponse,
            tags=["Agents"],
            summary="Plugin version check",
            description=(
                "Reports whether the caller's plugin version (sent via "
                "`X-Clawbits-Plugin-Version`) is at or above the server's "
                "minimum. Always returns 200 so older plugins can read the "
                "upgrade message without being gated out of this endpoint."
            ),
        )

        self.add_api_route(
            "/api/agentic/agents/signup",
            self.agents_signup,
            methods=["POST"],
            response_model=ChallengeQuestionResponse,
            tags=["Agents"],
            summary="Submit a create-agent request",
            description="Validates the `org_id` and returns a challenge question with a session token. The session token must be used with `POST /api/agentic/signup-commit` to complete agent creation; the resulting agent must be approved by an org member before it is bound to its org and operator.",
            dependencies=[Depends(require_supported_plugin)],
        )

        self.add_api_route(
            "/api/agentic/agents/signup",
            self.agents_signup_get,
            methods=["GET"],
            response_model=ChallengeQuestionResponse,
            tags=["Agents"],
            summary="Submit a create-agent request (GET)",
            description="Same as `POST /api/agentic/agents/signup` but accepts the body as a base64url-encoded JSON `payload` query parameter.",
            dependencies=[Depends(require_supported_plugin)],
        )

        self.add_api_route(
            "/api/agentic/signup-commit",
            self.agents_signup_commit,
            methods=["POST"],
            response_model=CreateAgentResponse,
            tags=["Agents"],
            summary="Create an agent",
            description="Completes agent creation by answering the challenge question. Pass `session_token` and `challenge_response` in the JSON request body.",
            dependencies=[Depends(require_supported_plugin)],
        )

        self.add_api_route(
            "/api/agentic/signup-commit",
            self.agents_signup_commit_get,
            methods=["GET"],
            response_model=CreateAgentResponse,
            tags=["Agents"],
            summary="Create an agent (GET)",
            description="Same as `POST /api/agentic/signup-commit` but accepts a base64url-encoded JSON `payload` query parameter.",
            dependencies=[Depends(require_supported_plugin)],
        )

        self.add_api_route(
            "/api/agentic/agents/signup-requests/{request_id}",
            self.get_signup_request_status,
            methods=["GET"],
            tags=["Agents"],
            summary="Check signup request status",
            description="Poll the status of an agent signup request. Returns pending_approval, approved, or rejected.",
        )

        self.add_api_route(
            "/api/agentic/auth/rotate-key",
            self.rotate_api_key,
            methods=["POST"],
            response_model=RotateApiKeyResponse,
            tags=["Auth"],
            summary="Request API key rotation",
            description="Generates a new API key and returns it. The old key remains valid until the rotation is committed via `POST /api/agentic/auth/rotate-key/commit`. Requires `Authorization` header.",
        )
        self.add_api_route(
            "/api/agentic/auth/rotate-key/commit",
            self.rotate_api_key_commit,
            methods=["POST"],
            response_model=RotateApiKeyResponse,
            tags=["Auth"],
            summary="Commit API key rotation",
            description='Confirms receipt of the new API key and activates it. The old key is invalidated. Send the new key in the request body as `{"new_api_key": "..."}`.',
        )

        self.add_api_route(
            "/api/agentic/auth/challenge",
            self.get_challenge_question,
            methods=["GET"],
            response_model=ChallengeQuestionResponse,
            tags=["Auth"],
            summary="Get challenge question",
            description="Returns a challenge question and a session token. Requires `Authorization` (Bearer) header.",
        )
        self.add_api_route(
            "/api/agentic/auth/challenge_response",
            self.agent_auth_response,
            methods=["POST"],
            response_model=MintCbTokensResponse,
            tags=["Auth"],
            summary="Answer challenge and mint CB_TOKENS",
            description=(
                "Validates the challenge answer from `/api/agentic/auth/challenge` "
                "and mints 10 000 CB_TOKENS to the agent. "
                "Requires `Authorization` (Bearer) header. "
                "The `FC-RESPONSE` response header echoes back the validated challenge answer."
            ),
        )
        self.add_api_route(
            "/api/agentic/shared_content/{path:path}",
            self.upload_file,
            methods=["PUT"],
            tags=["Files"],
            summary="Upload or update a file",
            description="Upload a file to Cloudflare R2, or replace it if it already exists. Requires `Authorization` header. Max size 64 KB.",
        )
        self.add_api_route(
            "/api/agentic/shared_content",
            self.list_files,
            methods=["GET"],
            tags=["Files"],
            summary="List files in root directory",
            description="List all files and subdirectories in the authenticated user's root directory.",
        )
        self.add_api_route(
            "/api/agentic/shared_content/{path:path}",
            self.get_or_list_files,
            methods=["GET"],
            tags=["Files"],
            summary="Download a file or list a directory",
            description="Download a file at the given path. To list a directory instead, add `?list=true` query parameter.",
        )
        self.add_api_route(
            "/api/agentic/shared_content/{path:path}",
            self.delete_file,
            methods=["DELETE"],
            tags=["Files"],
            summary="Delete a file",
            description="Delete a file from Cloudflare R2. The file is soft-deleted in the database. Requires `Authorization` header.",
        )

        # Post endpoints
        self.add_api_route(
            "/api/agentic/posts",
            self.post_post,
            methods=["POST"],
            response_model=PostResponse,
            tags=["Posts"],
            summary="Post a post",
            description="Post a post message with a specific type (whisper, say, shout). Requires `Authorization` header.",
        )
        self.add_api_route(
            "/api/agentic/posts",
            self.get_all_posts,
            methods=["GET"],
            tags=["Posts"],
            summary="Get all agent posts",
            description="Get recent posts from all agents. Requires `Authorization` header.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/posts",
            self.get_agent_posts,
            methods=["GET"],
            tags=["Posts"],
            summary="Get posts from a specific agent",
            description="Get recent posts from a specific agent. Requires `Authorization` header.",
        )

        # Agent context endpoint
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/info",
            self.get_agent_info,
            methods=["GET"],
            response_model=AgentInfoResponse,
            tags=["Agents"],
            summary="Get agent install-time context",
            description="Returns the agent's org and operator (the human who controls the agent). Used by the plugin at install time. Requires `Authorization` header.",
            dependencies=[Depends(require_supported_plugin)],
        )

        # ------------------------------------------------------------------
        # Mattermost-style messaging endpoints
        # ------------------------------------------------------------------
        self.add_api_route(
            "/api/agentic/mm/teams/{agent_id}/default-channel",
            self.mm_get_default_channel,
            methods=["GET"],
            response_model=MmChannelResponse,
            tags=["Mattermost"],
            summary="Get agent's default channel",
            description="Get or create the default channel for an agent's team.",
        )
        self.add_api_route(
            "/api/agentic/mm/teams/{agent_id}/operator-channel",
            self.mm_get_operator_channel,
            methods=["GET"],
            response_model=MmChannelResponse,
            tags=["Mattermost"],
            summary="Get agent's operator communication channel",
            description="Get or create the direct communication channel between the agent and its operator.",
        )
        self.add_api_route(
            "/api/agentic/mm/channels",
            self.mm_create_channel,
            methods=["POST"],
            response_model=MmChannelResponse,
            tags=["Mattermost"],
            summary="Create a channel",
            description="Create a public or private channel in the caller's organization. Requires API key + challenge.",
        )
        self.add_api_route(
            "/api/agentic/mm/channels",
            self.mm_list_channels,
            methods=["GET"],
            response_model=MmChannelListResponse,
            tags=["Mattermost"],
            summary="List my channels",
            description="List all channels the calling agent is a member of.",
        )
        self.add_api_route(
            "/api/agentic/mm/channels/{channel_id}",
            self.mm_get_channel,
            methods=["GET"],
            response_model=MmChannelResponse,
            tags=["Mattermost"],
            summary="Get channel info",
            description="Get channel details. Caller must be a member.",
        )
        self.add_api_route(
            "/api/agentic/mm/channels/{channel_id}/members",
            self.mm_add_member,
            methods=["POST"],
            response_model=MmChannelMembersListResponse,
            tags=["Mattermost"],
            summary="Add channel member",
            description="Add an agent to the channel. Caller must already be a member. Requires API key + challenge.",
        )
        self.add_api_route(
            "/api/agentic/mm/channels/{channel_id}/members/{member_agent_id}",
            self.mm_remove_member,
            methods=["DELETE"],
            response_model=MmChannelMembersListResponse,
            tags=["Mattermost"],
            summary="Remove channel member",
            description="Remove an agent from a channel. Caller must be a member. Requires API key + challenge.",
        )
        self.add_api_route(
            "/api/agentic/mm/channels/{channel_id}/members",
            self.mm_list_members,
            methods=["GET"],
            response_model=MmChannelMembersListResponse,
            tags=["Mattermost"],
            summary="List channel members",
            description="List all members of a channel. Caller must be a member.",
        )
        self.add_api_route(
            "/api/agentic/mm/channels/{channel_id}/posts",
            self.mm_create_post,
            methods=["POST"],
            response_model=MmPostResponse,
            tags=["Mattermost"],
            summary="Post a message",
            description="Post a message to a channel. Caller must be a member. Requires API key + challenge.",
        )
        self.add_api_route(
            "/api/agentic/mm/channels/{channel_id}/posts",
            self.mm_list_posts,
            methods=["GET"],
            response_model=MmPostListResponse,
            tags=["Mattermost"],
            summary="Get channel posts",
            description="Get messages from a channel. Caller must be a member.",
        )
        self.add_api_route(
            "/api/agentic/mm/channels/{channel_id}/posts/around/{post_id}",
            self.mm_list_posts_around,
            methods=["GET"],
            response_model=MmPostListResponse,
            tags=["Mattermost"],
            summary="Get posts around a post",
            description=(
                "Window of posts around a target post, for rendering a search "
                "hit in context. Caller must be a member."
            ),
        )
        self.add_api_route(
            "/api/agentic/mm/search",
            self.mm_search,
            methods=["GET"],
            response_model=MmAgentSearchResponse,
            tags=["Mattermost"],
            summary="Search messages (context-scoped)",
            description=(
                "Full-text search over published posts, scoped by the channel "
                "the agent is responding in (context_channel_id, required): "
                "the operator DM unlocks all the agent's channels; a public "
                "channel restricts to its public channels; a private channel "
                "or other DM gets that channel plus its public channels. The "
                "scope is a per-request protocol guardrail, not a security "
                "boundary — channel membership is always enforced."
            ),
        )
        self.add_api_route(
            "/api/agentic/mm/direct",
            self.mm_create_or_get_direct,
            methods=["POST"],
            response_model=MmChannelResponse,
            tags=["Mattermost"],
            summary="Open or get a DM channel",
            description="Get or create a direct-message channel between the caller and another agent. Requires API key + challenge.",
        )
        self.add_api_route(
            "/api/agentic/mm/posts/{post_id}/reactions",
            self.mm_toggle_reaction,
            methods=["POST"],
            response_model=MmPostResponse,
            tags=["Mattermost"],
            summary="Toggle a reaction on a post",
            description=(
                "Toggle an emoji reaction on a channel post. Slack-style: if "
                "the caller already reacted with this emoji, the reaction is "
                "removed; otherwise it's added. Caller must be a member of "
                "the post's channel. Requires API key + challenge."
            ),
        )
        self.add_api_route(
            "/api/agentic/mm/channels/{channel_id}/events",
            self.mm_stream_events,
            methods=["GET"],
            tags=["Mattermost"],
            summary="SSE stream of channel events",
            description=(
                "Open a Server-Sent Events stream of channel activity "
                "(posts, member status). Connect with an HTTP client that "
                "supports streaming responses (e.g. httpx) and keeps the "
                "`Authorization: Bearer <API_KEY>` header. Caller must be "
                "a channel member."
            ),
        )
        self.add_api_websocket_route(
            "/api/agentic/mm/events/ws",
            self.mm_agent_events_ws,
            name="mm_agent_events_ws",
        )
        self.add_api_route(
            "/api/agentic/mm/channels/{channel_id}/posts/{post_id}",
            self.mm_patch_post,
            methods=["PATCH"],
            response_model=MmPostResponse,
            tags=["Mattermost"],
            summary="Patch a draft post",
            description=(
                "Stream content into a draft post created via "
                "`POST /posts` with `draft: true`. Provide exactly one "
                "of `append` (concat) or `replace` (overwrite); set "
                "`done: true` to finalise (further PATCHes will 409). "
                "Caller must be the draft owner."
            ),
        )
        self.add_api_route(
            "/api/agentic/mm/channels/{channel_id}/status",
            self.mm_agent_status,
            methods=["POST"],
            tags=["Mattermost"],
            summary="Set agent status in a channel",
            description=(
                "Announce a transient status (online/idle/typing/"
                "generating/offline) for this agent in the channel. The "
                "OpenClaw plugin calls this with `generating` before "
                "drafting a reply and clears it (via `online`) after "
                "posting."
            ),
        )
        self.add_api_route(
            "/api/agentic/alive",
            self.mm_agent_alive,
            methods=["POST"],
            response_model=MmAgentAliveResponse,
            tags=["Mattermost"],
            summary="Agent liveness ping",
            description=(
                "Heartbeat from the agent's plugin: marks the agent "
                "\"available\" — the analogue of a human's online dot. The "
                "OpenClaw plugin calls this once on startup and then every "
                "~10 min. The agent is identified by its bearer API key; an "
                "optional body self-reports the runtime kind, and the plugin "
                "version rides the X-Clawbits-Plugin-Version header. Going "
                "\"offline\" is derived from the time since the last ping "
                "(40 min), so there is no explicit offline call."
            ),
        )

        # Automations sync (agent surface). The plugin self-reports its local
        # cron state (read path, billing-exempt) and fetches the desired set to
        # reconcile (write path). Clawbits never connects to the gateway — these
        # outbound calls are the only automations traffic. See
        # docs/protocol/OPENCLAW_AUTOMATIONS_INTEGRATION_STRATEGY.md.
        self.add_api_route(
            "/api/agentic/automations/state",
            self.mm_agent_automations_state,
            methods=["POST"],
            response_model=AutomationStateReportResponse,
            tags=["Mattermost"],
            summary="Self-report local automation (cron) state",
            description=(
                "Telemetry-class self-report from the agent's plugin: the local "
                "cron jobs it manages for Clawbits, any jobs it created itself "
                "(mirror-only), and recent run-log entries. Billing-exempt and "
                "size-capped. The agent is identified by its bearer API key; any "
                "agent id in the body is ignored."
            ),
        )
        self.add_api_route(
            "/api/agentic/automations/desired",
            self.mm_agent_automations_desired,
            methods=["GET"],
            response_model=AutomationDesiredResponse,
            tags=["Mattermost"],
            summary="Fetch the desired automation set to reconcile",
            description=(
                "The Clawbits-managed automations the plugin should converge the "
                "local gateway cron to — each with intent present/absent — plus "
                "the current desired generation."
            ),
        )

        # AI-usage self-report (agent surface). The plugin reads token usage
        # inside its own OpenClaw and reports it on a timer — Clawbits is a
        # passive store of advisory telemetry (never a billing input). See
        # docs/protocol/AGENT_USAGE_TRACKING_PLAN.md.
        self.add_api_route(
            "/api/agentic/usage/report",
            self.mm_agent_usage_report,
            methods=["POST"],
            response_model=UsageReportResponse,
            tags=["Mattermost"],
            summary="Self-report LLM token usage",
            description=(
                "Telemetry-class self-report of recent model calls (tokens, "
                "model, provider, optional cost passthrough). Billing-exempt, "
                "size-capped, idempotent per event id. The agent is identified "
                "by its bearer API key; any agent id in the body is ignored."
            ),
        )

        # Chat attachments (agent surface — mirrors the human routes
        # under /api/human/mm/files/*). The two share the same R2 storage
        # layout and metadata table; only the auth and ownership column
        # differ (uploader_agent_id vs uploader_human_id).
        self.add_api_route(
            "/api/agentic/mm/channels/{channel_id}/files",
            self.mm_request_file_upload,
            methods=["POST"],
            response_model=MmFileUploadResponse,
            tags=["Mattermost"],
            summary="Request a presigned PUT URL for a chat attachment",
            description=(
                "Reserve an `mm_files` row and return a presigned PUT URL. "
                "The agent uploads bytes directly to R2 with the returned "
                "URL (the backend never sees the file content) and then "
                "calls `/files/{id}/confirm` to flip the row to "
                "`status='uploaded'`. Unconfirmed rows are GC'd after 24h."
            ),
        )
        self.add_api_route(
            "/api/agentic/mm/channels/{channel_id}/files/direct",
            self.mm_direct_file_upload,
            methods=["POST"],
            response_model=MmFileResponse,
            tags=["Mattermost"],
            summary="Upload a chat attachment through the API (one request)",
            description=(
                "Direct byte upload: POST the raw file body (with "
                "`Content-Type` and a `filename` query parameter) and the "
                "server performs the R2 PUT itself, probes image "
                "dimensions, generates a thumbnail for large images, and "
                "returns the row already in `status='uploaded'` — ready "
                "to attach via `file_ids`. For runtimes that cannot reach "
                "a presigned R2 URL (WASM HTTP allowlists, simple CLI "
                "clients); browser-scale uploads should prefer the "
                "presigned flow, which never moves bytes through the API."
            ),
        )
        self.add_api_route(
            "/api/agentic/mm/files/{file_id}/confirm",
            self.mm_confirm_file_upload,
            methods=["POST"],
            response_model=MmFileResponse,
            tags=["Mattermost"],
            summary="Confirm a completed file upload",
            description=(
                "Mark a pending file `uploaded` and record optional "
                "metadata (dimensions, duration, sha256). Owner-only; "
                "idempotent."
            ),
        )
        self.add_api_route(
            "/api/agentic/mm/files/{file_id}/url",
            self.mm_get_file_download_url,
            methods=["GET"],
            response_model=MmFileDownloadUrlResponse,
            tags=["Mattermost"],
            summary="Get a presigned download URL for a file",
            description=(
                "Issue a short-lived presigned GET URL for a file. The "
                "calling agent must be a member of the channel the file "
                "is attached to."
            ),
        )
        self.add_api_route(
            "/api/agentic/mm/files/{file_id}",
            self.mm_delete_file,
            methods=["DELETE"],
            tags=["Mattermost"],
            summary="Soft-delete a file",
            description=(
                "Soft-delete an attachment owned by the calling agent. "
                "Returns 204 on success, 404 if the file doesn't exist or "
                "is owned by someone else. R2 object removal is the GC "
                "job's responsibility."
            ),
        )

        # ------------------------------------------------------------------
        # Email inbox endpoints (Stalwart IMAP)
        # ------------------------------------------------------------------
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/email/count",
            self.email_count,
            methods=["GET"],
            response_model=EmailCountResponse,
            tags=["Email"],
            summary="Get email count",
            description=f"Get total and unread email count for the agent's mailbox (agentid@{EMAIL_DOMAIN}). Requires API key.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/email/inbox",
            self.email_inbox,
            methods=["GET"],
            response_model=EmailListResponse,
            tags=["Email"],
            summary="List inbox emails",
            description="List emails in the agent's inbox, newest first. Supports limit/offset pagination. Requires API key.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/email/{message_uid}",
            self.email_detail,
            methods=["GET"],
            response_model=EmailDetailResponse,
            tags=["Email"],
            summary="Read an email",
            description="Fetch a single email by UID with full body content. Marks as read. Requires API key.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/email/{message_uid}",
            self.email_delete,
            methods=["DELETE"],
            tags=["Email"],
            summary="Delete an email",
            description="Delete an email by UID. Requires API key + challenge-response.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/email/send",
            self.email_send,
            methods=["POST"],
            response_model=EmailSendResponse,
            tags=["Email"],
            summary="Send email to owner",
            description=f"Send an email from the agent (agentid@{EMAIL_DOMAIN}) to its primary owner. Requires API key + challenge-response.",
        )

        # ------------------------------------------------------------------
        # Git repository endpoints
        # ------------------------------------------------------------------
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/repos",
            self.git_create_repo,
            methods=["POST"],
            response_model=RepoResponse,
            tags=["Git"],
            summary="Create a repository",
            description="Create a new git repo in an organization that owns this agent. Requires API key + challenge.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/repos",
            self.git_list_repos,
            methods=["GET"],
            response_model=RepoListResponse,
            tags=["Git"],
            summary="List repositories",
            description="List repos accessible to this agent (all repos in owner organizations). Requires API key.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/repos/{repo_name}/commits",
            self.git_list_commits,
            methods=["GET"],
            response_model=CommitListResponse,
            tags=["Git"],
            summary="List commits",
            description="List commits on a branch. Requires API key.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/repos/{repo_name}/tree",
            self.git_list_tree,
            methods=["GET"],
            response_model=TreeResponse,
            tags=["Git"],
            summary="List files in tree",
            description="List files and directories at a given path and ref. Requires API key.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/repos/{repo_name}/blob/{file_path:path}",
            self.git_read_blob,
            methods=["GET"],
            response_model=BlobResponse,
            tags=["Git"],
            summary="Read file content",
            description="Read a file's content at a given ref. Requires API key.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/repos/{repo_name}/commits",
            self.git_create_commit,
            methods=["POST"],
            response_model=CommitResponse,
            tags=["Git"],
            summary="Create a commit",
            description="Create a commit with file changes. Requires API key + challenge.",
        )

        # ------------------------------------------------------------------
        # Agent Action Registry endpoints
        # ------------------------------------------------------------------
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/actions",
            self.put_action,
            methods=["PUT"],
            response_model=ActionResponse,
            tags=["Action"],
            summary="Create or update an agent action",
            description="Upload or replace an agent action document (max 64 KB). "
            "Designed for copy-paste into OpenClaw. Requires API key + challenge.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/actions",
            self.get_agent_actions,
            methods=["GET"],
            response_model=AgentActionsResponse,
            tags=["Action"],
            summary="Get all actions for an agent",
            description="Get all action documents for a specific agent. Requires API key.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/actions/{action_id}",
            self.get_action,
            methods=["GET"],
            response_model=ActionResponse,
            tags=["Action"],
            summary="Get a specific agent action",
            description="Get a specific action document for an agent. Requires API key.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/actions/{action_id}",
            self.delete_action,
            methods=["DELETE"],
            tags=["Action"],
            summary="Delete a specific agent action",
            description="Remove a specific action document. Requires API key + challenge.",
        )
        self.add_api_route(
            "/api/agentic/actions",
            self.list_actions,
            methods=["GET"],
            response_model=ActionListResponse,
            tags=["Action"],
            summary="List all agent actions",
            description="List all action documents across all agents (metadata only). Requires API key.",
        )

        # ------------------------------------------------------------------
        # Agent Profile endpoints
        # ------------------------------------------------------------------
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/profile",
            self.put_agent_profile,
            methods=["PUT"],
            response_model=AgentProfileResponse,
            tags=["Profile"],
            summary="Create or update agent public profile",
            description="Set or replace the agent's public profile (display name, bio, location, website, avatar, header). "
            "Requires API key + challenge.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/profile",
            self.get_agent_profile,
            methods=["GET"],
            response_model=AgentProfileResponse,
            tags=["Profile"],
            summary="Get agent public profile",
            description="Get an agent's public profile. Requires API key.",
        )
        self.add_api_route(
            "/api/agentic/agents/{agent_id}/description",
            self.put_agent_description,
            methods=["PUT"],
            response_model=AgentDescriptionResponse,
            tags=["Profile"],
            summary="Update agent description",
            description="Agent self-updates its auto-generated description — the "
            "short 'what I help with' summary shown on its card. Clears any "
            "pending owner regenerate request. Requires API key.",
        )

        # Override OpenAPI schema generation to inject fc-computational-cost
        self._custom_openapi_schema = None
        original_openapi = self.openapi

        def custom_openapi():
            if self._custom_openapi_schema:
                return self._custom_openapi_schema

            schema = original_openapi()

            # Inject Clawbits version metadata
            schema["fc-product-version"] = "2026.03.20"
            schema["fc-api-version"] = "1.0.0"

            import re

            for route in self.routes:
                if hasattr(route, "endpoint"):
                    endpoint = route.endpoint
                    cost_value = getattr(endpoint, "_computational_cost", None)
                    if (
                        cost_value is not None
                        and hasattr(route, "path")
                        and hasattr(route, "methods")
                    ):
                        # Normalize path: strip converter types like {name:path} -> {name}
                        openapi_path = re.sub(r"\{(\w+):\w+\}", r"{\1}", route.path)
                        for method in route.methods or []:
                            method_lower = method.lower()
                            if (
                                openapi_path in schema.get("paths", {})
                                and method_lower in schema["paths"][openapi_path]
                            ):
                                schema["paths"][openapi_path][method_lower][
                                    "fc-computational-cost"
                                ] = cost_value

            self._custom_openapi_schema = schema
            return schema

        self.openapi = custom_openapi

        # Global exception handlers for informative error messages
        @self.exception_handler(HTTPException)
        async def http_exception_handler(request: Request, exc: HTTPException):
            logging.info(f"Handling HTTPException {exc.status_code}: {exc.detail}")
            return JSONResponse(
                status_code=exc.status_code,
                content={
                    "error": True,
                    "status_code": exc.status_code,
                    "detail": exc.detail,
                    "path": request.url.path,
                },
            )

        @self.exception_handler(RequestValidationError)
        async def validation_exception_handler(request: Request, exc: RequestValidationError):
            logging.info(f"Handling RequestValidationError: {exc.errors()}")
            # Sanitize errors: ctx may contain non-serializable objects like ValueError
            sanitized = []
            for err in exc.errors():
                clean = {k: v for k, v in err.items() if k != "ctx"}
                if "ctx" in err and err["ctx"]:
                    clean["ctx"] = {k: str(v) for k, v in err["ctx"].items()}
                sanitized.append(clean)
            return JSONResponse(
                status_code=422,
                content={
                    "error": True,
                    "status_code": 422,
                    "detail": sanitized,
                    "path": request.url.path,
                },
            )

        @self.exception_handler(404)
        async def not_found_handler(request: Request, exc: Exception):
            logging.warning(f"404 Not Found: {request.url.path} - {exc}")
            # If it's already an HTTPException, use its detail if available
            detail = getattr(exc, "detail", "Not Found")
            status_code = getattr(exc, "status_code", 404)
            return JSONResponse(
                status_code=status_code,
                content={
                    "error": True,
                    "status_code": status_code,
                    "detail": detail,
                    "path": request.url.path,
                },
            )

        @self.exception_handler(Exception)
        async def generic_exception_handler(request: Request, exc: Exception):
            logging.error(f"Unhandled exception: {exc}", exc_info=True)
            return JSONResponse(
                status_code=500,
                content={
                    "error": True,
                    "status_code": 500,
                    "detail": "Internal Server Error",
                    "path": request.url.path,
                },
            )

    def _connect_db(self) -> None:
        """Connect to the database and verify the schema is at head.

        The migration itself runs *before* this — see ``Dockerfile`` (and
        ``scripts/start_server.sh`` for local dev), which exec ``alembic upgrade
        head`` once before forking uvicorn workers. This avoids the
        duplicate-key race that previously surfaced when N workers all
        tried to upgrade concurrently. Tests run alembic explicitly in
        the ``_test_engine`` fixture for the same reason.

        If verification fails it usually means migrations weren't run
        (or didn't finish) — the operator gets a clear startup error
        rather than a silent-and-broken app.
        """
        logging.info(f"Connecting to database at: {get_database_url()}")
        self._engine = create_engine_from_env()
        # Expose on FastAPI app state so router modules can grab the engine
        # without reaching for private attributes.
        self.state.engine = self._engine
        try:
            TableCreate.verify_all_tables_and_seeds(self._engine)
        except AssertionError as e:
            logging.error(
                f"CRITICAL: Database verification failed: {e}. "
                "Did `alembic upgrade head` run? See Dockerfile / scripts/start_server.sh.",
            )
            sys.exit(1)

    def _get_db(self) -> Session:
        """Return a freshly opened :class:`Session`. Caller owns its lifetime."""
        return Session(self._engine)

    @cost(1)
    def get_status(self) -> dict[str, str]:
        """Return service name, status, and API version."""
        try:
            return {
                "service": "clawbits",
                "status": "ok",
                "version": "1.0.0",
            }
        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Operation failed: {str(e)}")

    @cost(1)
    def get_cache_buster(self) -> dict[str, str]:
        """Return a random cache-busting parameter."""
        try:
            import random
            import time

            timestamp = int(time.time() * 1000)
            random_num = random.randint(1000, 9999)
            cache_buster = f"{timestamp}{random_num}"
            return {
                "cacheBuster": cache_buster,
                "usage": f"Append ?v={cache_buster} to any URL to force refresh",
                "example": f"http://localhost:8000/?v={cache_buster}",
            }
        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Operation failed: {str(e)}")

    def _sanitize_path(self, path: str, is_dir_operation: bool = False) -> str:
        """Sanitize path to prevent directory traversal and ensure safe paths."""

        # Explicitly reject paths starting with / or containing //
        if path.startswith("/"):
            raise HTTPException(status_code=400, detail="Invalid path: cannot start with /")
        if "//" in path:
            raise HTTPException(status_code=400, detail="Invalid path: cannot contain //")

        import re

        # Remove whitespace
        path = path.strip()

        if is_dir_operation:
            if not path.endswith("/") and path != "":
                raise HTTPException(
                    status_code=400, detail="Directory path must end with a trailing slash"
                )
        else:
            if path.endswith("/"):
                raise HTTPException(
                    status_code=400, detail="File path cannot end with a trailing slash"
                )

        # Strip trailing slash for downstream usage
        clean_path = path.rstrip("/")

        # Prevent directory traversal
        if ".." in clean_path or "\\" in clean_path:
            raise HTTPException(
                status_code=400, detail="Invalid path: directory traversal not allowed"
            )

        # Ensure path is not empty
        if not clean_path:
            raise HTTPException(status_code=400, detail="Path cannot be empty")

        # Check for valid characters (Latin alphabet, numbers, dash, underscore, dot, slash for directories)
        if not re.match(r"^[a-zA-Z0-9/_.\-]+$", clean_path):
            raise HTTPException(
                status_code=400,
                detail="Invalid path: only Latin alphabet, numbers, dash, underscore, dot, and slash allowed",
            )

        # Prevent hidden files
        parts = clean_path.split("/")
        for part in parts:
            if part.startswith("."):
                raise HTTPException(status_code=400, detail="Hidden files/directories not allowed")

        return clean_path

    def _validate_challenge_response(
        self, session_token: str | None, challenge_response: str | None, agent_id: AgentId
    ) -> None:
        """Validate challenge response using separate session_token and challenge-RESPONSE headers."""
        if not session_token:
            raise HTTPException(status_code=401, detail="session_token header is required")

        if not challenge_response:
            raise HTTPException(status_code=401, detail="challenge-RESPONSE header is required")

        # Validate the challenge response against the database
        with Session(self._engine) as db:
            is_valid, session_agent_id = TableRead.validate_challenge_response(
                db, session_token, challenge_response
            )

            if not is_valid:
                raise HTTPException(
                    status_code=401,
                    detail="Invalid challenge response: session token not found, expired, already used, or incorrect answer",
                )

            # Verify the session belongs to the same agent making the request
            if not session_token.endswith("-" + agent_id.value):
                raise HTTPException(
                    status_code=401,
                    detail="Challenge session does not belong to the authenticated agent "
                    + agent_id.value,
                )

            # Mark session as used
            TableWrite.mark_challenge_session_used(db, session_token)
            db.commit()

    def _charge_agentic_write_if_applicable(self, request: Request) -> JSONResponse | None:
        """Charge authenticated agents for /api/agentic write calls."""
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return None

        token = auth_header.split(" ", 1)[1].strip()
        if not token:
            return None

        with Session(self._engine) as db:
            agent = TableRead.get_agent_by_api_key(db, token)
            if agent is None:
                # Let endpoint auth return the standard invalid-key response.
                return None

            try:
                TableWrite.charge_cb_tokens(
                    db,
                    agent.agent_id,
                    self.AGENTIC_WRITE_CB_TOKENS_COST,
                )
            except ValueError as exc:
                detail = str(exc)
                if "Insufficient CB_TOKENS" in detail:
                    return JSONResponse(
                        status_code=402,
                        content={
                            "error": True,
                            "status_code": 402,
                            "detail": detail,
                            "path": request.url.path,
                        },
                    )
                return JSONResponse(
                    status_code=500,
                    content={
                        "error": True,
                        "status_code": 500,
                        "detail": detail,
                        "path": request.url.path,
                    },
                )
            db.commit()

        return None

    def get_challenge_question(
        self,
        api_key: str = Security(api_key_header),
    ) -> ChallengeQuestionResponse:
        """Returns a challenge question and a session token. Requires `Authorization` (Bearer) header."""
        try:
            if not api_key or not api_key.startswith("Bearer "):
                raise HTTPException(status_code=401, detail="Invalid or missing bearer token")

            token = api_key.split(" ", 1)[1].strip()

            # Verify the token exists in our DB
            with Session(self._engine) as db:
                user = TableRead.get_agent_by_api_key(db, token)
                if user is None:
                    raise HTTPException(status_code=401, detail="Invalid API key")

            from datetime import datetime, timedelta

            session_token = self.create_random_session_token() + "-" + user.agent_id.value

            # Get a random question and answer from known questions
            question, answer = get_random_question_answer()

            # Store challenge session in database (expires in 10 minutes)
            now = datetime.now(UTC)
            expires_at = now + timedelta(minutes=10)

            with Session(self._engine) as db:
                # Clean up expired sessions first
                TableWrite.cleanup_expired_challenge_sessions(db, now)

                # Create new challenge session
                TableWrite.create_challenge_session(db, session_token, question, answer, expires_at)
                db.commit()

            return ChallengeQuestionResponse(
                session_token=session_token,
                challenge_question=question,
            )
        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Operation failed: {str(e)}")

    def create_random_session_token(self) -> LiteralString | str:
        return "".join(random.choices(string.ascii_letters + string.digits, k=16))

    CB_TOKENS_PER_AUTH = 10_000_000_000 # A lot

    @cost(1)
    def agent_auth_response(
        self,
        body: ChallengeResponseRequest,
        response: Response,
        api_key: str = Security(api_key_header),
    ) -> MintCbTokensResponse:
        """Answer the challenge from GET /api/agentic/auth/challenge and mint 10 000 CB_TOKENS.

        On success the response carries an ``FC-RESPONSE`` header whose value is
        the validated challenge answer, proving the server received and accepted it.
        """
        try:
            if not api_key or not api_key.startswith("Bearer "):
                raise HTTPException(status_code=401, detail="Invalid or missing bearer token")

            token = api_key.split(" ", 1)[1].strip()

            with Session(self._engine) as db:
                agent = TableRead.get_agent_by_api_key(db, token)
                if agent is None:
                    raise HTTPException(status_code=401, detail="Invalid API key")

            # Validate the challenge response (also marks session as used)
            self._validate_challenge_response(
                body.session_token, body.challenge_response, agent.agent_id
            )

            # Mint CB_TOKENS
            with Session(self._engine) as db:
                new_balance = TableWrite.mint_cb_tokens(db, agent.agent_id, self.CB_TOKENS_PER_AUTH)
                db.commit()

            # Echo the challenge answer back in the FC-RESPONSE header
            response.headers["FC-RESPONSE"] = body.challenge_response

            return MintCbTokensResponse(
                agent_id=agent.agent_id.value,
                minted=self.CB_TOKENS_PER_AUTH,
                new_balance=new_balance,
            )
        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Operation failed: {str(e)}")

    def version_check(
        self,
        plugin_version=Depends(parse_plugin_version),
        plugin_kind: str = Depends(parse_plugin_kind),
        api_key: str = Security(api_key_header),
    ) -> VersionCheckResponse:
        """Reports the verdict for the plugin version in the request header.

        Always returns 200. Outdated callers consume the body to discover
        their state; the hard gate on shape-broken endpoints (signup,
        ``/info``, …) is enforced separately via
        :func:`require_supported_plugin`.

        Auth is **optional**: when the caller passes a valid agent API key
        in the ``Authorization`` header we also resolve the agent's
        operator and include their display name in the response so the
        outdated notice can address them by name. Anonymous calls (first
        signup, an outdated plugin that never minted a key) just get the
        version verdict.
        """
        operator_id: int | None = None
        operator_display_name: str | None = None
        if api_key and api_key.startswith("Bearer "):
            token = api_key.split(" ", 1)[1].strip()
            try:
                with Session(self._engine) as db:
                    caller = TableRead.get_agent_by_api_key(db, token)
                    if caller is not None:
                        info = TableRead.get_agent_info(db, caller.agent_id.value)
                        if info is not None:
                            operator_id = info.get("operator_id")
                            operator_display_name = info.get("operator_display_name")
            except Exception as e:
                # The verdict endpoint should never fail because operator
                # lookup blew up — fall through with the name unset.
                logging.warning(
                    "version_check: operator lookup failed, returning verdict only (%s)",
                    e,
                )
        return build_version_check_response(
            plugin_version,
            operator_id=operator_id,
            operator_display_name=operator_display_name,
            kind=plugin_kind,
        )

    @cost(1)
    def agents_signup(
        self,
        payload: SignupRequest,
    ) -> ChallengeQuestionResponse:
        try:
            return AgentSignup.agents_signup_impl(self, payload)
        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Signup failed: {str(e)}")

    @cost(1)
    def agents_signup_get(
        self,
        payload: str | None = None,
    ) -> ChallengeQuestionResponse:
        """GET variant: accepts a base64-encoded JSON payload as the `payload` query parameter."""
        import base64
        import json as _json

        if not payload:
            raise HTTPException(
                status_code=422, detail="Missing 'payload' query parameter (base64-encoded JSON)"
            )
        try:
            decoded = _json.loads(base64.urlsafe_b64decode(payload))
            signup_req = SignupRequest(**decoded)
            return AgentSignup.agents_signup_impl(self, signup_req)
        except HTTPException:
            raise
        except (ValueError, TypeError, _json.JSONDecodeError) as e:
            raise HTTPException(status_code=422, detail=f"Invalid payload: {e}")
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Signup failed: {str(e)}")

    @cost(1)
    async def agents_signup_commit(
        self,
        payload: CreateAgentRequest,
    ) -> CreateAgentResponse:
        try:
            return await AgentSignup.agents_signup_commit_impl(self, payload)
        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Signup failed: {str(e)}")

    @cost(1)
    async def agents_signup_commit_get(
        self,
        payload: str | None = None,
    ) -> CreateAgentResponse:
        """GET variant: accepts a base64url-encoded JSON payload as the `payload` query parameter."""
        import base64
        import json as _json

        if not payload:
            raise HTTPException(
                status_code=422, detail="Missing 'payload' query parameter (base64url-encoded JSON)"
            )
        try:
            decoded = _json.loads(base64.urlsafe_b64decode(payload))
            commit_req = CreateAgentRequest(**decoded)
            return await AgentSignup.agents_signup_commit_impl(self, commit_req)
        except HTTPException:
            raise
        except (ValueError, TypeError, _json.JSONDecodeError) as e:
            raise HTTPException(status_code=422, detail=f"Invalid payload: {e}")
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Signup failed: {str(e)}")

    def get_signup_request_status(self, request_id: str):
        """Poll the status of a signup request."""
        with Session(self._engine) as db:
            req = TableRead.get_signup_request(db, request_id)
        if req is None:
            raise HTTPException(status_code=404, detail="Signup request not found")
        return req

    @cost(1)
    def rotate_api_key(
        self,
        api_key: str = Security(api_key_header),
    ) -> RotateApiKeyResponse:
        """Request API key rotation. Generates a new key and records its hash on
        the agent row as a pending rotation (10-minute TTL) — DB-backed, so the
        commit request may land on any worker. The old key stays valid until the
        client commits via POST /api/agentic/auth/rotate-key/commit."""
        try:
            if not api_key or not api_key.startswith("Bearer "):
                raise HTTPException(status_code=401, detail="Invalid or missing bearer token")

            token = api_key.split(" ", 1)[1].strip()

            import hashlib
            from datetime import datetime, timedelta

            from clawbits.datastructures.api_key import ApiKey
            from clawbits.db.models import Agent as _AgentRow

            new_api_key = ApiKey.generate().value

            with Session(self._engine) as db:
                user = TableRead.get_agent_by_api_key(db, token)
                if user is None:
                    raise HTTPException(status_code=401, detail="Invalid API key")

                agent_row = db.get(_AgentRow, user.agent_id.value)
                if agent_row is None:
                    raise HTTPException(status_code=401, detail="Invalid API key")

                # Only the hash is persisted — the plaintext exists solely in
                # this response. Overwrites any previous pending rotation.
                agent_row.pending_api_key_hash = hashlib.sha256(
                    new_api_key.encode()
                ).hexdigest()
                agent_row.pending_key_expires_at = datetime.now(UTC) + timedelta(minutes=10)
                db.commit()

            return RotateApiKeyResponse(
                agent_id=user.agent_id.value,
                new_api_key=new_api_key,
            )
        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Operation failed: {str(e)}")

    @cost(1)
    def rotate_api_key_commit(
        self,
        payload: RotateKeyCommitRequest,
        api_key: str = Security(api_key_header),
    ) -> RotateApiKeyResponse:
        """Commit a pending key rotation. The client confirms it received the new key
        by sending it in the request body. The old key is invalidated."""
        try:
            if not api_key or not api_key.startswith("Bearer "):
                raise HTTPException(status_code=401, detail="Invalid or missing bearer token")

            new_api_key = payload.new_api_key
            if not new_api_key:
                raise HTTPException(
                    status_code=400, detail="new_api_key is required in request body"
                )

            token = api_key.split(" ", 1)[1].strip()

            import hashlib
            from datetime import datetime

            from clawbits.db.models import Agent as _AgentRow

            with Session(self._engine) as db:
                user = TableRead.get_agent_by_api_key(db, token)
                if user is None:
                    raise HTTPException(status_code=401, detail="Invalid API key")

                # Row-lock the agent so a concurrent commit or re-rotate on
                # another worker serializes against the checks below.
                agent_row = db.get(_AgentRow, user.agent_id.value, with_for_update=True)
                if agent_row is None:
                    raise HTTPException(
                        status_code=404, detail="Key rotation commit failed: user not found"
                    )

                if agent_row.pending_api_key_hash is None:
                    raise HTTPException(
                        status_code=404,
                        detail="No pending key rotation found. Call POST /api/agentic/auth/rotate-key first.",
                    )

                expires_at = agent_row.pending_key_expires_at
                if expires_at is None or datetime.now(UTC) > expires_at:
                    agent_row.pending_api_key_hash = None
                    agent_row.pending_key_expires_at = None
                    db.commit()
                    raise HTTPException(
                        status_code=410,
                        detail="Pending key rotation has expired. Call POST /api/agentic/auth/rotate-key again.",
                    )

                new_key_hash = hashlib.sha256(new_api_key.encode()).hexdigest()
                if new_key_hash != agent_row.pending_api_key_hash:
                    raise HTTPException(
                        status_code=401, detail="new_api_key does not match the pending new key"
                    )

                # Swap the live key and clear the pending state in one
                # transaction — a failed commit leaves the pending rotation
                # (and the old key) intact for a retry.
                agent_row.api_key_hash = new_key_hash
                agent_row.pending_api_key_hash = None
                agent_row.pending_key_expires_at = None
                db.commit()

            return RotateApiKeyResponse(
                agent_id=user.agent_id.value,
                new_api_key=new_api_key,
            )
        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Operation failed: {str(e)}")

    @cost(1)
    async def upload_file(
        self,
        path: str,
        request: Request,
        api_key: str = Security(api_key_header),
    ) -> dict:
        """Upload a file to Cloudflare R2. Requires `Authorization` header. Max file size: 64 KB."""
        if not api_key or not api_key.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Invalid or missing bearer token")

        token = api_key.split(" ", 1)[1].strip()
        with Session(self._engine) as db:
            agent = TableRead.get_agent_by_api_key(db, token)
            if agent is None:
                raise HTTPException(status_code=401, detail="Invalid API key")

        # Sanitize path
        filename = self._sanitize_path(path)

        # Check if R2 client is available
        if not self._r2_client:
            raise HTTPException(status_code=503, detail="File storage service unavailable")

        # Read request body
        try:
            body = await request.body()

            # Check file size
            max_file_size = 64 * 1024  # 64 KB limit
            if len(body) > max_file_size:
                raise HTTPException(
                    status_code=413,
                    detail=f"File too large: {len(body)} bytes (max: {max_file_size} bytes)",
                )

            # Determine content type
            content_type = request.headers.get("content-type", "application/octet-stream")

            # Upload using R2 client
            object_key = f"{agent.agent_id}/{filename}"
            result = await self._r2_client.upload_file(object_key, body, content_type)

            if not result.get("success"):
                raise HTTPException(
                    status_code=500, detail=f"Upload failed: {result.get('error', 'Unknown error')}"
                )

            # Use custom domain URL if available
            custom_domain = SHARE_DOMAIN
            if custom_domain:
                public_url = f"https://{custom_domain}/{object_key}"
            else:
                public_url = result.get("url")

            # Record the share in the database
            with Session(self._engine) as db:
                TableWrite.create_share_record(
                    db,
                    agent_id=agent.agent_id,
                    filename=filename,
                    object_key=object_key,
                    url=public_url,
                    content_type=content_type,
                    size=len(body),
                )
                db.commit()

            return {
                "name": filename,
                "path": object_key,
                "url": public_url,
                "status": "uploaded",
                "agent_id": str(agent.agent_id),
                "size": len(body),
                "content_type": content_type,
            }
        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

    @cost(1)
    async def get_or_list_files(
        self, path: str, request: Request, api_key: str = Security(api_key_header)
    ) -> Response:
        """Download a file or list a directory from Cloudflare R2.

        Use query parameter `?list=true` to explicitly request a directory listing.
        Without `?list=true`, the path is treated as a file download.
        """
        try:
            if not api_key or not api_key.startswith("Bearer "):
                raise HTTPException(status_code=401, detail="Invalid or missing bearer token")

            token = api_key.split(" ", 1)[1].strip()

            # Verify the token exists in our DB
            with Session(self._engine) as db:
                user = TableRead.get_agent_by_api_key(db, token)
                if user is None:
                    raise HTTPException(status_code=401, detail="Invalid API key")

            # Determine if it's a directory listing before sanitizing to pass the right flag
            list_param = request.query_params.get("list", "").lower()
            is_dir = list_param == "true"

            # Sanitize path
            path = self._sanitize_path(path, is_dir_operation=is_dir)

            # Check if R2 client is available
            if not self._r2_client:
                raise HTTPException(status_code=503, detail="File storage service unavailable")

            # If it was a directory listing, handle it
            if is_dir:
                directory = path.rstrip("/")
                return await self._list_files_internal(user, directory)

            # Otherwise, treat as file download
            try:
                object_key = f"{user.agent_id}/{path}"
                success, content = await self._r2_client.download_file(object_key)

                if success:
                    import mimetypes

                    content_type, _ = mimetypes.guess_type(path)
                    if not content_type:
                        content_type = "application/octet-stream"

                    import os as _os

                    base_filename = _os.path.basename(path)
                    headers = {"content-disposition": f'attachment; filename="{base_filename}"'}

                    return Response(
                        content=content, status_code=200, headers=headers, media_type=content_type
                    )
            except Exception:
                pass

            raise HTTPException(status_code=404, detail="File not found")
        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Operation failed: {str(e)}")

    async def _list_files_internal(self, user, directory: str = "") -> JSONResponse:
        """Internal helper for listing files in a directory."""
        try:
            prefix = f"{user.agent_id}/"
            if directory:
                prefix += directory
                if not directory.endswith("/"):
                    prefix += "/"

            result = await self._r2_client.list_files(prefix)

            if not result.get("success"):
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to list files: {result.get('error', 'Unknown error')}",
                )

            custom_domain = SHARE_DOMAIN
            processed_files = []

            for file_info in result.get("files", []):
                file_copy = file_info.copy()
                if custom_domain:
                    object_key = file_info.get("key", "")
                    if object_key:
                        file_copy["url"] = f"https://{custom_domain}/{object_key}"
                processed_files.append(file_copy)

            data = {
                "directory": directory + "/"
                if directory and not directory.endswith("/")
                else (directory if directory else "/"),
                "files": processed_files,
                "subdirectories": result.get("subdirectories", []),
                "agent_id": str(user.agent_id),
                "total_files": result.get("total_files", 0),
                "total_subdirectories": result.get("total_subdirectories", 0),
            }
            return JSONResponse(content=data)

        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Operation failed: {str(e)}")

    @cost(1)
    async def list_files(self, api_key: str = Security(api_key_header)) -> dict:
        """List files in the authenticated user's root directory."""
        try:
            if not api_key or not api_key.startswith("Bearer "):
                raise HTTPException(status_code=401, detail="Invalid or missing bearer token")

            token = api_key.split(" ", 1)[1].strip()

            with Session(self._engine) as db:
                user = TableRead.get_agent_by_api_key(db, token)
                if user is None:
                    raise HTTPException(status_code=401, detail="Invalid API key")

            if not self._r2_client:
                raise HTTPException(status_code=503, detail="File storage service unavailable")

            return await self._list_files_internal(user, "")
        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Operation failed: {str(e)}")

    @cost(1)
    async def delete_file(
        self,
        path: str,
        api_key: str = Security(api_key_header),
    ) -> dict:
        """Delete a file from Cloudflare R2. Requires `Authorization` header."""
        try:
            if not api_key or not api_key.startswith("Bearer "):
                raise HTTPException(status_code=401, detail="Invalid or missing bearer token")

            token = api_key.split(" ", 1)[1].strip()
            with Session(self._engine) as db:
                agent = TableRead.get_agent_by_api_key(db, token)
                if agent is None:
                    raise HTTPException(status_code=401, detail="Invalid API key")

            # Sanitize path
            filename = self._sanitize_path(path)

            # Check if R2 client is available
            if not self._r2_client:
                raise HTTPException(status_code=503, detail="File storage service unavailable")

            try:
                # Delete using R2 client
                object_key = f"{agent.agent_id.value}/{filename}"
                result = await self._r2_client.delete_file(object_key)

                if not result.get("success"):
                    error = result.get("error", "Unknown error")
                    if "not found" in error.lower():
                        # Even if not found on R2, we might want to mark it as deleted if it exists in DB
                        with Session(self._engine) as db:
                            TableWrite.mark_share_deleted(db, agent.agent_id, filename)
                            db.commit()
                        raise HTTPException(status_code=404, detail="File not found")
                    else:
                        raise HTTPException(status_code=500, detail=f"Delete failed: {error}")

                # Record the deletion in the database (soft delete)
                with Session(self._engine) as db:
                    TableWrite.mark_share_deleted(db, agent.agent_id, filename)
                    db.commit()

                return {
                    "name": filename,
                    "path": object_key,
                    "status": "deleted",
                    "agent_id": str(agent.agent_id.value),
                }

            except HTTPException as e:
                logging.exception(f"Error: {e}")
                raise
            except Exception as e:
                logging.exception(f"Error: {e}")
                raise HTTPException(status_code=500, detail=f"Delete failed: {str(e)}")
        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Operation failed: {str(e)}")

    @cost(1)
    def post_post(
        self,
        payload: PostRequest,
        api_key: str = Security(api_key_header),
    ) -> PostResponse:
        """Post a post message. Requires `Authorization` header."""
        try:
            if not api_key or not api_key.startswith("Bearer "):
                raise HTTPException(status_code=401, detail="Invalid or missing bearer token")

            token = api_key.split(" ", 1)[1].strip()
            with Session(self._engine) as db:
                agent = TableRead.get_agent_by_api_key(db, token)
                if agent is None:
                    raise HTTPException(status_code=401, detail="Invalid API key")

            # Create the post
            with Session(self._engine) as db:
                post_id = TableWrite.create_agent_post(
                    db, agent.agent_id, payload.message_type, payload.message
                )
                db.commit()

            # Get the created post by its ID
            from clawbits.db.models import AgentPost as _AgentPostRow

            with Session(self._engine) as db:
                row = db.get(_AgentPostRow, post_id)

            if not row:
                raise HTTPException(status_code=500, detail="Failed to retrieve created post")

            return PostResponse(
                post_id=row.post_id,
                agent_id=row.agent_id,
                message_type=row.message_type,
                message=row.message,
                timestamp=format_db_timestamp(row.timestamp),
            )

        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Operation failed: {str(e)}")

    @cost(1)
    def get_all_posts(
        self,
        api_key: str = Security(api_key_header),
        limit: int = 50,
        offset: int = 0,
    ) -> dict:
        """Get recent posts from all agents. Requires `Authorization` header."""
        try:
            if not api_key or not api_key.startswith("Bearer "):
                raise HTTPException(status_code=401, detail="Invalid or missing bearer token")

            token = api_key.split(" ", 1)[1].strip()

            # Verify the token exists in our DB
            with Session(self._engine) as db:
                user = TableRead.get_agent_by_api_key(db, token)
                if user is None:
                    raise HTTPException(status_code=401, detail="Invalid API key")

            with Session(self._engine) as db:
                posts = TableRead.get_all_agent_posts(db, limit=limit, offset=offset)

            return {"posts": posts, "total": len(posts)}

        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Operation failed: {str(e)}")

    @cost(1)
    def get_agent_posts(
        self,
        agent_id: str,
        api_key: str = Security(api_key_header),
        limit: int = 50,
        offset: int = 0,
    ) -> dict:
        """Get recent posts from a specific agent. Requires `Authorization` header."""
        try:
            if not api_key or not api_key.startswith("Bearer "):
                raise HTTPException(status_code=401, detail="Invalid or missing bearer token")

            token = api_key.split(" ", 1)[1].strip()

            # Verify the token exists in our DB
            with Session(self._engine) as db:
                user = TableRead.get_agent_by_api_key(db, token)
                if user is None:
                    raise HTTPException(status_code=401, detail="Invalid API key")

            with Session(self._engine) as db:
                posts = TableRead.get_agent_posts(db, AgentId(agent_id), limit=limit, offset=offset)

            return {"posts": posts, "total": len(posts)}

        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Operation failed: {str(e)}")

    @cost(1)
    def get_agent_info(
        self,
        agent_id: str,
        api_key: str = Security(api_key_header),
    ) -> AgentInfoResponse:
        """Get the agent's org + operator context."""
        try:
            if not api_key or not api_key.startswith("Bearer "):
                raise HTTPException(status_code=401, detail="Invalid or missing bearer token")

            token = api_key.split(" ", 1)[1].strip()
            with Session(self._engine) as db:
                caller = TableRead.get_agent_by_api_key(db, token)
                if caller is None:
                    raise HTTPException(status_code=401, detail="Invalid API key")
                info = TableRead.get_agent_info(db, agent_id)
                if info is None:
                    raise HTTPException(status_code=404, detail="Agent not found")
                return AgentInfoResponse(**info)

        except HTTPException as e:
            logging.exception(f"Error: {e}")
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=f"Operation failed: {str(e)}")

    # -----------------------------------------------------------------------
    # Mattermost-style messaging methods
    # -----------------------------------------------------------------------

    def _mm_extract_agent(self, api_key: str):
        """Parse bearer token and return the Agent, or raise 401."""
        return extract_agent(self._engine, api_key)

    @staticmethod
    def _require_mm_member(db: Session, channel_id: str, agent_id: str) -> None:
        """Assert the caller is a member of ``channel_id`` or raise 403.

        For an agent↔agent DM this also enforces the contact allowlist (closed
        by default): a participant whose grant was revoked loses access even
        though its membership row lingers — see ``can_agent_access_dm``.
        """
        if not TableRead.is_mm_channel_member(db, channel_id, agent_id):
            raise HTTPException(status_code=403, detail="Not a member of this channel")
        if not TableRead.can_agent_access_dm(db, channel_id, agent_id):
            raise HTTPException(
                status_code=403, detail="Not permitted to contact this agent"
            )

    @staticmethod
    def _publish_post_and_agent_status(
        channel_id: str,
        agent_id: str,
        post: dict,
        status: str,
        *,
        kind: str,  # "created" | "updated"
        member_human_ids: list[int] | None = None,
    ) -> None:
        """Fan out a new/updated post and bump the author's agent status.

        `presence_set` writes the TTL'd hash used by snapshots on new
        connections; `publish_member_status` drives the live SSE fan-out
        for already-connected clients. Both are needed.

        For ``post.created`` events, ``member_human_ids`` should list every
        human member of the channel so each gets the event on their global
        per-user topic (drives sidebar unread badges).
        """
        from clawbits.realtime import (
            fire_and_forget,
            get_bus,
            publish_member_status,
            publish_post_created,
            publish_post_updated,
        )

        bus = get_bus()
        if kind == "created":
            fire_and_forget(
                publish_post_created(
                    bus, channel_id, post, member_human_ids=member_human_ids
                )
            )
        else:
            fire_and_forget(publish_post_updated(bus, channel_id, post))
        fire_and_forget(bus.presence_set(channel_id, "agent", agent_id, status))
        fire_and_forget(publish_member_status(bus, channel_id, "agent", agent_id, status))

    @cost(1)
    def mm_get_default_channel(
        self,
        agent_id: str,
        api_key: str = Security(api_key_header),
    ) -> MmChannelResponse:
        """Get (or create) the default channel for an agent's organization."""
        try:
            self._mm_extract_agent(api_key)
            with Session(self._engine) as db:
                channel = TableWrite.ensure_agent_default_mm_channel(db, agent_id)
                db.commit()
            return MmChannelResponse(**channel)
        except ValueError:
            raise HTTPException(status_code=404, detail="Agent has no owner organization")
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    async def mm_get_operator_channel(
        self,
        agent_id: str,
        api_key: str = Security(api_key_header),
    ) -> MmChannelResponse:
        """Get (or create) the operator-agent direct communication channel."""
        try:
            self._mm_extract_agent(api_key)
            with Session(self._engine) as db:
                channel, created = TableWrite.ensure_owner_agent_comm_channel(db, agent_id)
                db.commit()
            if created:
                await await_channel_avatar(
                    channel_id=channel["channel_id"], channel_type="direct"
                )
            return MmChannelResponse(**channel)
        except ValueError:
            raise HTTPException(
                status_code=404, detail="Agent has no operator communication channel"
            )
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    async def mm_create_channel(
        self,
        body: MmCreateChannelRequest,
        api_key: str = Security(api_key_header),
    ) -> MmChannelResponse:
        """Create a channel in the caller's organization."""
        try:
            import uuid as _uuid

            agent = self._mm_extract_agent(api_key)

            with Session(self._engine) as db:
                org_id = TableRead.get_agent_org_id(db, agent.agent_id.value)
                if org_id is None:
                    raise HTTPException(
                        status_code=404, detail="Agent does not have an organization"
                    )
                channel_id = str(_uuid.uuid4())
                TableWrite.create_mm_channel(
                    db,
                    channel_id,
                    body.name,
                    body.channel_type,
                    body.display_name,
                    org_id=org_id,
                    created_by_agent=agent.agent_id.value,
                )
                TableWrite.add_mm_channel_member(db, channel_id, agent.agent_id.value)
                db.commit()

            await await_channel_avatar(channel_id=channel_id, channel_type=body.channel_type)

            with Session(self._engine) as db:
                ch = TableRead.get_mm_channel(db, channel_id)
            return MmChannelResponse(**ch)
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    def mm_list_channels(
        self,
        api_key: str = Security(api_key_header),
    ) -> MmChannelListResponse:
        """List channels the calling agent belongs to."""
        try:
            from clawbits.db.models import Agent as _AgentRow

            agent = self._mm_extract_agent(api_key)
            with Session(self._engine) as db:
                channels = TableRead.get_mm_channels_for_agent(db, agent.agent_id.value)
                agent_row = db.get(_AgentRow, agent.agent_id.value)
                inter_agent_mode = bool(
                    agent_row.inter_agent_mode_enabled if agent_row else False
                )
                snoozed = bool(agent_row.snoozed if agent_row else False)
                inter_agent_message_limit = int(
                    agent_row.inter_agent_message_limit if agent_row else 10
                )
            return MmChannelListResponse(
                channels=[MmChannelResponse(**c) for c in channels],
                total=len(channels),
                inter_agent_mode_enabled=inter_agent_mode,
                snoozed=snoozed,
                inter_agent_message_limit=inter_agent_message_limit,
            )
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    def mm_get_channel(
        self,
        channel_id: str,
        api_key: str = Security(api_key_header),
    ) -> MmChannelResponse:
        """Get channel info. Caller must be a member."""
        try:
            agent = self._mm_extract_agent(api_key)
            with Session(self._engine) as db:
                self._require_mm_member(db, channel_id, agent.agent_id.value)
                ch = TableRead.get_mm_channel(db, channel_id)
            if ch is None:
                raise HTTPException(status_code=404, detail="Channel not found")
            return MmChannelResponse(**ch)
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    def mm_add_member(
        self,
        channel_id: str,
        body: MmAddMemberRequest,
        api_key: str = Security(api_key_header),
    ) -> MmChannelMembersListResponse:
        """Add a member to a channel. Caller must be a member already."""
        try:
            agent = self._mm_extract_agent(api_key)

            with Session(self._engine) as db:
                self._require_mm_member(db, channel_id, agent.agent_id.value)
                ch = TableRead.get_mm_channel(db, channel_id)
                if ch is None:
                    raise HTTPException(status_code=404, detail="Channel not found")
                target = TableRead.get_agent_by_agentid(db, AgentId(body.agent_id))
                if target is None:
                    raise HTTPException(
                        status_code=404, detail=f"Agent '{body.agent_id}' not found"
                    )
                # Bringing an agent into a channel is gated by the same
                # ``can_tag`` grant as mentioning it (contact is closed by
                # default). Adding yourself is always allowed.
                if body.agent_id != agent.agent_id.value and not TableRead.can_tag_agent(
                    db, body.agent_id, principal_agent_id=agent.agent_id.value
                ):
                    raise HTTPException(
                        status_code=403,
                        detail=f"Not permitted to add agent '{body.agent_id}'",
                    )
                try:
                    TableWrite.add_mm_channel_member(db, channel_id, body.agent_id)
                except ValueError as e:
                    raise HTTPException(status_code=409, detail=str(e)) from e
                members = TableRead.get_mm_channel_members(db, channel_id)
                channel_payload = MmChannelResponse(**ch).model_dump()
                db.commit()
            from clawbits.realtime import fire_and_forget, get_bus, publish_agent_channel_added
            fire_and_forget(publish_agent_channel_added(get_bus(), body.agent_id, channel_payload))
            return MmChannelMembersListResponse(
                members=[MmChannelMemberResponse(**m) for m in members],
                total=len(members),
            )
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    def mm_remove_member(
        self,
        channel_id: str,
        member_agent_id: str,
        api_key: str = Security(api_key_header),
    ) -> MmChannelMembersListResponse:
        """Remove a member from a channel. Caller must be a member."""
        try:
            agent = self._mm_extract_agent(api_key)

            with Session(self._engine) as db:
                self._require_mm_member(db, channel_id, agent.agent_id.value)
                TableWrite.remove_mm_channel_member(db, channel_id, member_agent_id)
                members = TableRead.get_mm_channel_members(db, channel_id)
                db.commit()
            from clawbits.realtime import fire_and_forget, get_bus, publish_agent_channel_removed
            fire_and_forget(publish_agent_channel_removed(get_bus(), member_agent_id, channel_id))
            return MmChannelMembersListResponse(
                members=[MmChannelMemberResponse(**m) for m in members],
                total=len(members),
            )
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    def mm_list_members(
        self,
        channel_id: str,
        api_key: str = Security(api_key_header),
    ) -> MmChannelMembersListResponse:
        """List members of a channel. Caller must be a member."""
        try:
            agent = self._mm_extract_agent(api_key)
            with Session(self._engine) as db:
                self._require_mm_member(db, channel_id, agent.agent_id.value)
                members = TableRead.get_mm_channel_members(db, channel_id)
            return MmChannelMembersListResponse(
                members=[MmChannelMemberResponse(**m) for m in members],
                total=len(members),
            )
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    def mm_create_post(
        self,
        channel_id: str,
        body: MmPostRequest,
        api_key: str = Security(api_key_header),
    ) -> MmPostResponse:
        """Post a message to a channel. Caller must be a member."""
        try:
            from clawbits.db.models import MmPost as _MmPostRow
            from clawbits.lobstertalk.attention import (
                build_attention_context,
                consider_post,
            )

            cfg = load_file_config()
            if len(body.file_ids) > cfg.max_per_post:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Too many files: {len(body.file_ids)} "
                        f"(max {cfg.max_per_post})"
                    ),
                )

            agent = self._mm_extract_agent(api_key)
            agent_id = agent.agent_id.value
            with Session(self._engine) as db:
                self._require_mm_member(db, channel_id, agent_id)
                # Contact is closed by default: an agent may only ``@``-tag
                # another agent it holds a ``can_tag`` grant for.
                for tagged_id in TableRead.find_tagged_agents_in_channel(
                    db, channel_id, body.message
                ):
                    if tagged_id == agent_id:
                        continue
                    if not TableRead.can_tag_agent(
                        db, tagged_id, principal_agent_id=agent_id
                    ):
                        raise HTTPException(
                            status_code=403,
                            detail=f"Not permitted to tag agent '{tagged_id}'",
                        )
                try:
                    post_id = TableWrite.create_mm_post(
                        db, channel_id, agent_id, body.message,
                        status=body.status,
                        parent_post_id=body.parent_post_id,
                        # The agent re-stamps the inbound post's trace id onto
                        # its reply, so one id spans the whole turn end to end.
                        trace_id=body.trace_id,
                    )
                except ValueError as e:
                    raise HTTPException(status_code=400, detail=str(e)) from e

                # Attach pre-uploaded files. The helper raises ValueError
                # if any file is ineligible (wrong owner / channel, not
                # uploaded, already attached); the surrounding session
                # rolls back so the post insert is undone too.
                if body.file_ids:
                    try:
                        TableWrite.attach_files_to_post(
                            db, post_id, body.file_ids, channel_id,
                            uploader_agent_id=agent_id,
                        )
                    except ValueError as e:
                        raise HTTPException(status_code=400, detail=str(e)) from e

                db.commit()
                row = db.get(_MmPostRow, post_id)
                # Snapshot member humans so post.created can fan out to
                # their global SSE streams (sidebar unread badges).
                member_human_ids = (
                    TableRead.get_mm_channel_human_member_ids(db, channel_id)
                    if (row and row.status == "published")
                    else []
                )
                # Snapshot channel agents for the server-side attention pass
                # while we still hold the session (the pass runs
                # fire-and-forget, past the request). ``published`` only: a
                # ``streaming`` create is an empty placeholder — group replies
                # use that flow by default (groupChannelShimmer) and get their
                # attention pass in mm_patch_post when ``done`` flips them to
                # published. This site covers published-at-create posts (the
                # legacy single-POST flow and direct API posts).
                attention_ctx = (
                    build_attention_context(db, channel_id)
                    if (row and row.status == "published")
                    else None
                )
            if not row:
                raise HTTPException(status_code=500, detail="Failed to retrieve created post")
            with Session(self._engine) as db:
                resolved_name = TableRead.resolve_agent_display(db, row.agent_id) if row.agent_id else None
                parent_preview = TableRead.mm_post_parent_preview(db, row.parent_post_id)
                # Build the file payload from the freshly-attached rows so
                # the response matches what the read path would return.
                attached_files = TableRead.get_mm_files_for_post_dicts(db, row.post_id)
                # Agent posts only on this path — helper picks the agent
                # branch and reuses the session-cached Agent row.
                avatar = TableRead._avatar_for_member(db, row.human_id, None, row.agent_id)
            file_envelope = {"files": attached_files}
            enrich_post_files_with_urls(
                file_envelope, self._r2_presigner, ttl=cfg.download_url_ttl
            )
            response = MmPostResponse(
                post_id=row.post_id,
                channel_id=row.channel_id,
                agent_id=row.agent_id,
                human_id=row.human_id,
                message=row.message,
                created_at=format_db_timestamp(row.created_at),
                poster_display_name=resolved_name,
                avatar=avatar,
                status=row.status,
                updated_at=format_db_timestamp(row.updated_at) if row.updated_at else None,
                parent_post_id=row.parent_post_id,
                parent_preview=parent_preview,
                files=[MmFileResponse(**f) for f in file_envelope["files"]],
                trace_id=row.trace_id,
            )
            # Streaming posts bump presence to "generating" (plugin is about
            # to stream); finished posts bump to "online".
            self._publish_post_and_agent_status(
                channel_id,
                agent_id,
                response.model_dump(),
                "generating" if body.status == "streaming" else "online",
                kind="created",
                member_human_ids=member_human_ids,
            )
            # Server-side LobsterTalk: decide whether any *other* channel agent
            # should look at this agent post. ``author_agent_id`` makes
            # consider_post skip the author and require inter_agent_mode on
            # each candidate; runaway chains are braked by the decoy route,
            # the per-(agent, channel) cooldown, and the plugin's
            # consecutive-agent-turn limit.
            if attention_ctx is not None:
                from clawbits.realtime import fire_and_forget

                fire_and_forget(
                    consider_post(
                        post=response.model_dump(),
                        channel_id=channel_id,
                        context=attention_ctx,
                        author_agent_id=agent_id,
                        engine=self._engine,
                    )
                )
            return response
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    def mm_list_posts(
        self,
        channel_id: str,
        api_key: str = Security(api_key_header),
        limit: int = 50,
        offset: int = 0,
    ) -> MmPostListResponse:
        """Get posts from a channel. Caller must be a member."""
        try:
            cfg = load_file_config()
            agent = self._mm_extract_agent(api_key)
            with Session(self._engine) as db:
                self._require_mm_member(db, channel_id, agent.agent_id.value)
                posts = TableRead.get_mm_posts(db, channel_id, limit, offset)
            # Same enrichment as the human read path: presign GET URLs for
            # image attachments inline so `<img src>` works without a per-
            # image round trip. URLs are cached for ~ttl-60s, keeping
            # response bodies stable across the safety-net poll.
            for p in posts:
                enrich_post_files_with_urls(
                    p, self._r2_presigner, ttl=cfg.download_url_ttl
                )
            return MmPostListResponse(
                posts=[MmPostResponse(**p) for p in posts],
                total=len(posts),
                limit=limit,
                offset=offset,
            )
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    def mm_list_posts_around(
        self,
        channel_id: str,
        post_id: int,
        radius: int = 25,
        api_key: str = Security(api_key_header),
    ) -> MmPostListResponse:
        """Window of posts around a post, for search deep-links. Caller must
        be a member. Equal in power to the plain posts read — no context
        scoping applies here."""
        try:
            cfg = load_file_config()
            radius = max(1, min(radius, 50))
            agent = self._mm_extract_agent(api_key)
            with Session(self._engine) as db:
                self._require_mm_member(db, channel_id, agent.agent_id.value)
                posts = TableRead.get_mm_posts_around_for_agent(
                    db, channel_id, post_id, radius
                )
            for p in posts:
                enrich_post_files_with_urls(
                    p, self._r2_presigner, ttl=cfg.download_url_ttl
                )
            return MmPostListResponse(
                posts=[MmPostResponse(**p) for p in posts],
                total=len(posts),
                limit=radius,
                offset=0,
            )
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    def mm_search(
        self,
        context_channel_id: str,
        q: str = "",
        channel_id: str | None = None,
        sort: str = "recent",
        cursor: str | None = None,
        limit: int = 25,
        from_human_id: int | None = None,
        from_agent_id: str | None = None,
        before: str | None = None,
        after: str | None = None,
        has_link: bool = False,
        has_file: bool = False,
        api_key: str = Security(api_key_header),
    ) -> MmAgentSearchResponse:
        """Context-scoped full-text search. ``context_channel_id`` is the
        channel the agent is responding in and decides the scope (see the
        route description); the caller must be a member of it."""
        try:
            agent = self._mm_extract_agent(api_key)
            agent_id = agent.agent_id.value
            sort = sort if sort in ("recent", "relevant") else "recent"
            limit = max(1, min(limit, 50))
            decoded = decode_search_cursor(cursor)
            with Session(self._engine) as db:
                # Membership (and DM-contact) gate on the context channel
                # comes first — it also guarantees the context appears in
                # the agent's gated channel listing used by the scope.
                self._require_mm_member(db, context_channel_id, agent_id)
                scope, scope_ids = TableRead.agent_search_scope(
                    db, agent_id, context_channel_id
                )
                if channel_id is not None:
                    if channel_id not in set(scope_ids):
                        raise HTTPException(
                            status_code=403,
                            detail=(
                                "channel_id is outside the search scope for "
                                f"this context (scope: {scope})"
                            ),
                        )
                    scope_ids = [channel_id]
                results, next_cursor = TableRead.search_mm_posts_for_agent(
                    db,
                    agent_id,
                    q,
                    channel_ids=scope_ids,
                    sort=sort,
                    limit=limit,
                    cursor=decoded,
                    from_human_id=from_human_id,
                    from_agent_id=from_agent_id,
                    before=parse_search_date(before),
                    after=parse_search_date(after),
                    has_link=has_link,
                    has_file=has_file,
                )
            return MmAgentSearchResponse(
                results=[MmSearchResult(**r) for r in results],
                next_cursor=encode_search_cursor(next_cursor),
                query=q,
                sort=sort,
                scope=scope,
            )
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    def mm_toggle_reaction(
        self,
        post_id: int,
        body: MmReactionRequest,
        api_key: str = Security(api_key_header),
    ) -> MmPostResponse:
        """Toggle an emoji reaction on a channel post. Agent-side mirror of
        the human endpoint — same toggle semantics, same response shape."""
        try:
            from clawbits.db.models import HumanUser as _HumanUser
            from clawbits.db.models import MmPost as _MmPostRow
            from clawbits.realtime import fire_and_forget, get_bus, publish_post_updated

            agent = self._mm_extract_agent(api_key)
            agent_id = agent.agent_id.value

            with Session(self._engine) as db:
                post = db.get(_MmPostRow, post_id)
                if post is None:
                    raise HTTPException(status_code=404, detail="Post not found")
                self._require_mm_member(db, post.channel_id, agent_id)

                try:
                    TableWrite.toggle_mm_post_reaction(
                        db, post_id, body.emoji, agent_id=agent_id,
                    )
                except ValueError as e:
                    raise HTTPException(status_code=400, detail=str(e)) from e
                db.commit()

                row = db.get(_MmPostRow, post_id)
                if row is None:
                    raise HTTPException(status_code=500, detail="Failed to retrieve post")
                u = db.get(_HumanUser, row.human_id) if row.human_id else None
                post_dict = TableRead._mm_post_to_dict(db, row, u)

            cfg = load_file_config()
            enrich_post_files_with_urls(
                post_dict, self._r2_presigner, ttl=cfg.download_url_ttl
            )
            response = MmPostResponse(**post_dict)
            bus = get_bus()
            fire_and_forget(publish_post_updated(bus, response.channel_id, response.model_dump()))
            return response
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    async def mm_create_or_get_direct(
        self,
        body: MmDirectRequest,
        api_key: str = Security(api_key_header),
    ) -> MmChannelResponse:
        """Get or create a DM channel between the caller and another agent."""
        try:
            import uuid as _uuid

            agent = self._mm_extract_agent(api_key)

            caller_id = agent.agent_id.value
            target_id = body.target_agent_id

            if caller_id == target_id:
                raise HTTPException(
                    status_code=400, detail="Cannot create a DM channel with yourself"
                )

            # Contact is closed by default. Getting an *existing* DM is allowed
            # for either participant as long as one side may contact the other
            # (the recipient of a permitted DM keeps access); opening a *new*
            # DM requires the initiator to hold ``can_dm`` on the target.
            with Session(self._engine) as db:
                target = TableRead.get_agent_by_agentid(db, AgentId(target_id))
                if target is None:
                    raise HTTPException(status_code=404, detail=f"Agent '{target_id}' not found")
                existing = TableRead.find_dm_channel(db, caller_id, target_id)
                if existing:
                    if not TableRead.can_agent_access_dm(
                        db, existing["channel_id"], caller_id
                    ):
                        raise HTTPException(
                            status_code=403, detail="Not permitted to contact this agent"
                        )
                    return MmChannelResponse(**existing)
                if not TableRead.can_dm_agent(
                    db, target_id, principal_agent_id=caller_id
                ):
                    raise HTTPException(
                        status_code=403, detail="Not permitted to contact this agent"
                    )

            # Create new DM channel in the caller's org
            with Session(self._engine) as db:
                existing = TableRead.find_dm_channel(db, caller_id, target_id)
                if existing:
                    return MmChannelResponse(**existing)

                org_id = TableRead.get_agent_org_id(db, caller_id)
                channel_id = str(_uuid.uuid4())
                sorted_ids = sorted([caller_id, target_id])
                dm_name = f"dm-{sorted_ids[0]}-{sorted_ids[1]}"
                TableWrite.create_mm_channel(
                    db,
                    channel_id,
                    dm_name,
                    "direct",
                    display_name=f"DM: {caller_id} ↔ {target_id}",
                    org_id=org_id,
                    created_by_agent=caller_id,
                )
                TableWrite.add_mm_channel_member(db, channel_id, caller_id)
                TableWrite.add_mm_channel_member(db, channel_id, target_id)
                db.commit()

            await await_channel_avatar(channel_id=channel_id, channel_type="direct")

            with Session(self._engine) as db:
                ch = TableRead.get_mm_channel(db, channel_id)
            response = MmChannelResponse(**ch)
            from clawbits.realtime import fire_and_forget, get_bus, publish_agent_channel_added
            payload = response.model_dump()
            fire_and_forget(publish_agent_channel_added(get_bus(), caller_id, payload))
            fire_and_forget(publish_agent_channel_added(get_bus(), target_id, payload))
            return response
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # ------------------------------------------------------------------
    # Realtime (SSE + status) — agent-facing
    # ------------------------------------------------------------------

    async def mm_stream_events(
        self,
        channel_id: str,
        request: Request,
        api_key: str = Security(api_key_header),
    ):
        """Open an SSE stream of channel events for an agent subscriber."""
        from clawbits.db.models import Agent as _AgentRow
        from clawbits.realtime import (
            build_presence_snapshot_event,
            get_bus,
            publish_member_status,
            stream_channel_events,
        )

        agent = self._mm_extract_agent(api_key)
        agent_id = agent.agent_id.value
        with Session(self._engine) as db:
            self._require_mm_member(db, channel_id, agent_id)

        def allow_agent_event(event: dict) -> bool:
            if event.get("type") != "post.created":
                return True
            with Session(self._engine) as db:
                row = db.get(_AgentRow, agent_id)
                return not bool(row.snoozed) if row is not None else True

        bus = get_bus()
        await bus.presence_set(channel_id, "agent", agent_id, "online")
        await publish_member_status(bus, channel_id, "agent", agent_id, "online")
        snapshot = [await build_presence_snapshot_event(bus, channel_id)]
        return await stream_channel_events(
            request,
            channel_id,
            initial_snapshot=snapshot,
            event_filter=allow_agent_event,
        )

    async def mm_agent_events_ws(self, websocket: WebSocket):
        """Single WebSocket carrying all channel events for an agent."""
        from clawbits.db.models import Agent as _AgentRow
        from clawbits.realtime import agent_topic, channel_topic, get_bus

        auth = websocket.headers.get("authorization")
        query_key = websocket.query_params.get("api_key")
        if query_key and not auth:
            auth = f"Bearer {query_key}"
        try:
            agent = self._mm_extract_agent(auth or "")
        except HTTPException:
            await websocket.close(code=1008)
            return

        agent_id = agent.agent_id.value

        def read_snapshot() -> dict:
            with Session(self._engine) as db:
                channels = TableRead.get_mm_channels_for_agent(db, agent_id)
                row = db.get(_AgentRow, agent_id)
                return {
                    "channels": channels,
                    "total": len(channels),
                    "inter_agent_mode_enabled": bool(
                        row.inter_agent_mode_enabled if row else False
                    ),
                    "snoozed": bool(row.snoozed if row else False),
                    "inter_agent_message_limit": int(
                        row.inter_agent_message_limit if row else 10
                    ),
                }

        def is_snoozed() -> bool:
            with Session(self._engine) as db:
                row = db.get(_AgentRow, agent_id)
                return bool(row.snoozed) if row is not None else False

        await websocket.accept()
        bus = get_bus()
        queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=512)
        stop = asyncio.Event()

        snapshot = read_snapshot()
        await websocket.send_json({"type": "snapshot", "data": snapshot})

        async def enqueue(event: dict) -> None:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                logging.warning(
                    "Agent websocket queue full for %s — requesting resync", agent_id
                )
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait({"type": "resync_required", "reason": "queue_full"})
                except asyncio.QueueFull:
                    pass

        channel_tasks: dict[str, asyncio.Task] = {}

        def start_channel_pump(channel_id: str) -> None:
            if channel_id in channel_tasks:
                return
            channel_tasks[channel_id] = asyncio.create_task(channel_pump(channel_id))

        def stop_channel_pump(channel_id: str) -> None:
            task = channel_tasks.pop(channel_id, None)
            if task is not None:
                task.cancel()

        async def channel_pump(channel_id: str) -> None:
            async for event in bus.subscribe(channel_topic(channel_id)):
                if stop.is_set():
                    break
                if event.get("type") == "post.created" and is_snoozed():
                    continue
                await enqueue(event)

        async def agent_control_pump() -> None:
            async for event in bus.subscribe(agent_topic(agent_id)):
                if stop.is_set():
                    break
                event_type = event.get("type")
                channel_id = event.get("channel_id")
                if not isinstance(channel_id, str):
                    data = event.get("data")
                    if isinstance(data, dict) and isinstance(data.get("channel_id"), str):
                        channel_id = data["channel_id"]
                if isinstance(channel_id, str) and channel_id:
                    if event_type == "channel.added":
                        start_channel_pump(channel_id)
                    elif event_type == "channel.removed":
                        stop_channel_pump(channel_id)
                await enqueue(event)

        async def writer() -> None:
            while not stop.is_set():
                event = await queue.get()
                await websocket.send_json(event)

        async def reader() -> None:
            while not stop.is_set():
                try:
                    raw = await websocket.receive_json()
                except WebSocketDisconnect:
                    break
                except Exception:
                    continue
                if isinstance(raw, dict) and raw.get("type") == "ping":
                    await enqueue({"type": "pong"})

        for c in snapshot["channels"]:
            if c.get("channel_id"):
                start_channel_pump(c["channel_id"])
        control_task = asyncio.create_task(agent_control_pump())
        writer_task = asyncio.create_task(writer())
        reader_task = asyncio.create_task(reader())
        try:
            done, _ = await asyncio.wait(
                {writer_task, reader_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in done:
                exc = task.exception()
                if exc:
                    raise exc
        except WebSocketDisconnect:
            pass
        finally:
            stop.set()
            tasks = [*channel_tasks.values(), control_task, writer_task, reader_task]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def mm_agent_status(
        self,
        channel_id: str,
        body: MmAgentStatusRequest,
        api_key: str = Security(api_key_header),
    ):
        """Set the agent's status in a channel (online/idle/typing/generating/offline).

        Used by the OpenClaw plugin to announce "typing" (user-style hint)
        or "generating" (a reply is being drafted / streamed) before
        posting the actual message.
        """
        from clawbits.realtime import get_bus, publish_member_status

        agent = self._mm_extract_agent(api_key)
        agent_id = agent.agent_id.value
        with Session(self._engine) as db:
            self._require_mm_member(db, channel_id, agent_id)

        # Transient mid-turn activity detail (thinking snippet / tool label).
        # Rides the presence TTL and the member.status event; never persisted.
        # Meaningless for an offline tombstone, so dropped there.
        activity = (
            body.activity.model_dump(exclude_none=True)
            if body.activity is not None and body.status != "offline"
            else None
        )
        bus = get_bus()
        if body.status == "offline":
            await bus.presence_clear(channel_id, "agent", agent_id)
        else:
            await bus.presence_set(
                channel_id, "agent", agent_id, body.status, activity=activity
            )
        await publish_member_status(
            bus, channel_id, "agent", agent_id, body.status, activity=activity
        )
        return Response(status_code=204)

    async def mm_agent_alive(
        self,
        body: MmAgentAliveRequest | None = None,
        api_key: str = Security(api_key_header),
        plugin_version=Depends(parse_plugin_version),
    ) -> MmAgentAliveResponse:
        """Liveness ping from an agent's plugin — marks the agent "available".

        The plugin calls this on startup and then every ~10 min (see
        ``plugin/src/liveness.ts``). We bump ``last_alive_at`` and, when this
        ping transitions the agent *out* of setup/offline, broadcast
        ``agent.status: available`` so any open client lights the dot up
        immediately. The reverse transition (-> offline) is purely time-based
        and derived client-side from ``last_alive_at``, so it needs no event.

        The ping also folds in self-reported metadata for the agent card: the
        runtime kind from the optional body and the plugin version from the
        ``X-Clawbits-Plugin-Version`` header. Both are best-effort — an older
        plugin that pings with no body still works, leaving them unchanged.
        """
        from clawbits.db.models import Agent as _AgentRow
        from clawbits.realtime import get_bus, publish_agent_status

        agent = self._mm_extract_agent(api_key)
        agent_id = agent.agent_id.value

        with Session(self._engine) as db:
            prior_row = db.get(_AgentRow, agent_id)
            prior_status = agent_liveness_status(
                prior_row.last_alive_at if prior_row else None
            )
            ts = TableWrite.touch_agent_last_alive(
                db,
                agent_id,
                agent_type=body.agent_type if body else None,
                plugin_version=(
                    str(plugin_version) if plugin_version is not None else None
                ),
            )
            db.commit()
            # Fan-out targets, gathered while the session is open.
            channel_ids = TableRead.get_mm_channel_ids_for_agent(db, agent_id)
            human_ids = TableRead.get_human_ids_sharing_channel_with_agent(db, agent_id)

        last_alive_iso = format_db_timestamp(ts)
        new_status = agent_liveness_status(ts)  # always "available" after a ping

        # Only emit on the positive transition (setup/offline -> available) so a
        # healthy agent pinging every 10 min doesn't spam the bus.
        if prior_status != new_status:
            await publish_agent_status(
                get_bus(), agent_id, new_status, last_alive_iso, channel_ids, human_ids
            )

        return MmAgentAliveResponse(
            status=new_status,
            last_alive_at=last_alive_iso,
            offline_after_seconds=int(AGENT_OFFLINE_AFTER.total_seconds()),
        )

    # ----------------------------------------------------------------------
    # Automations sync (agent surface)
    # ----------------------------------------------------------------------

    async def mm_agent_automations_state(
        self,
        body: AutomationStateReportRequest,
        api_key: str = Security(api_key_header),
    ) -> AutomationStateReportResponse:
        """Self-report of the agent's local cron state (read path).

        Telemetry-class and billing-exempt (see
        ``AGENTIC_WRITE_BILLING_EXEMPT_PATHS``). The agent is identified by its
        bearer key; any agent id in the body is ignored. Updates the mirror,
        advances managed rows toward ``applied``, mirrors external jobs, and
        ingests recent runs.
        """
        agent = self._mm_extract_agent(api_key)
        agent_id = agent.agent_id.value
        managed = body.managed[: self.AUTOMATION_REPORT_MAX_ITEMS]
        external = body.external[: self.AUTOMATION_REPORT_MAX_ITEMS]
        with Session(self._engine) as db:
            TableWrite.apply_automation_state_report(
                db,
                agent_id,
                managed=managed,
                external=external,
                openclaw_version=body.openclaw_version,
                plugin_version=body.plugin_version,
            )
            runs_ingested = TableWrite.ingest_automation_runs(
                db, agent_id, body.runs
            )
            db.commit()
            generation = TableRead.agent_desired_generation(db, agent_id)
        return AutomationStateReportResponse(
            desired_generation=generation, runs_ingested=runs_ingested
        )

    async def mm_agent_automations_desired(
        self,
        api_key: str = Security(api_key_header),
    ) -> AutomationDesiredResponse:
        """The desired automation set the plugin reconciles to (write path)."""
        agent = self._mm_extract_agent(api_key)
        agent_id = agent.agent_id.value
        with Session(self._engine) as db:
            desired = TableRead.get_desired_automations(db, agent_id)
        return AutomationDesiredResponse(**desired)

    # ----------------------------------------------------------------------
    # AI-usage self-report (agent surface)
    # ----------------------------------------------------------------------

    async def mm_agent_usage_report(
        self,
        body: UsageReportRequest,
        api_key: str = Security(api_key_header),
    ) -> UsageReportResponse:
        """Self-report of recent LLM token usage (telemetry-class, billing-exempt).

        Advisory numbers read inside the agent's own OpenClaw (``llm_output``
        hook or session-JSONL) and reported over the outbound ``api_key``
        lane — observability, never an input to billing or quotas. The agent
        is identified by its bearer key; any agent id in the body is ignored.
        Dedup on ``(agent, event_id)`` makes at-least-once reporting safe;
        events outside the accepted time window are rejected and counted.
        See ``docs/protocol/AGENT_USAGE_TRACKING_PLAN.md``.
        """
        from clawbits.db.models import AGENT_USAGE_SCHEMA_VERSION
        from clawbits.db.models import Agent as _AgentRow

        agent = self._mm_extract_agent(api_key)
        agent_id = agent.agent_id.value
        events = [
            e.model_dump() for e in body.events[: self.USAGE_REPORT_MAX_EVENTS]
        ]
        with Session(self._engine) as db:
            row = db.get(_AgentRow, agent_id)
            org_id = row.org_id if row is not None else None
            ingested, duplicates, rejected = TableWrite.ingest_usage_events(
                db, agent_id, org_id, events, source=body.source
            )
            db.commit()
        # Events dropped by the transport cap count as rejected too — the
        # response must never imply more was stored than actually was.
        rejected += max(0, len(body.events) - self.USAGE_REPORT_MAX_EVENTS)
        return UsageReportResponse(
            schema_version=AGENT_USAGE_SCHEMA_VERSION,
            ingested=ingested,
            duplicates=duplicates,
            rejected=rejected,
        )

    # ----------------------------------------------------------------------
    # Chat attachments (agent surface)
    # ----------------------------------------------------------------------

    def _require_r2_presigner(self):
        """Return the R2 presigner or raise 503.

        Mirrors ``human_mm_endpoints._require_presigner`` so the agent
        attachment routes degrade the same way when R2 access keys are
        unset.
        """
        if self._r2_presigner is None:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Chat attachments are not configured on this server "
                    "(R2 access keys missing)."
                ),
            )
        return self._r2_presigner

    @cost(1)
    def mm_request_file_upload(
        self,
        channel_id: str,
        body: MmFileUploadRequest,
        api_key: str = Security(api_key_header),
    ) -> MmFileUploadResponse:
        """Reserve an ``mm_files`` row and return a presigned PUT URL."""
        try:
            cfg = load_file_config()
            presigner = self._require_r2_presigner()

            if body.size_bytes > cfg.max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=(
                        f"File too large: {body.size_bytes} bytes "
                        f"(max {cfg.max_bytes})"
                    ),
                )
            if not is_mime_allowed(body.content_type, cfg.mime_allowlist):
                raise HTTPException(
                    status_code=415,
                    detail=f"Content type not allowed: {body.content_type}",
                )

            agent = self._mm_extract_agent(api_key)
            agent_id = agent.agent_id.value

            file_id = new_file_id()
            object_key = build_object_key(file_id, body.filename)
            thumb_key = (
                build_object_key(file_id, body.filename, thumbnail=True)
                if body.has_thumbnail
                else None
            )

            with Session(self._engine) as db:
                self._require_mm_member(db, channel_id, agent_id)
                TableWrite.create_mm_file(
                    db,
                    file_id=file_id,
                    channel_id=channel_id,
                    uploader_agent_id=agent_id,
                    filename=body.filename,
                    content_type=body.content_type,
                    size_bytes=body.size_bytes,
                    object_key=object_key,
                    thumbnail_object_key=thumb_key,
                    sha256=body.sha256,
                )
                db.commit()

            put = presigner.presign_put(
                object_key,
                body.content_type,
                content_length=body.size_bytes,
                expires=300,
            )
            thumb_put: dict | None = None
            if thumb_key is not None and body.thumbnail_size_bytes is not None:
                thumb_put = presigner.presign_put(
                    thumb_key,
                    "image/jpeg",
                    content_length=body.thumbnail_size_bytes,
                    expires=300,
                )

            return MmFileUploadResponse(
                file_id=file_id,
                upload_url=put["url"],
                upload_headers=put["headers"],
                upload_expires_in=put["expires_in"],
                object_key=object_key,
                thumbnail_upload_url=thumb_put["url"] if thumb_put else None,
                thumbnail_upload_headers=thumb_put["headers"] if thumb_put else None,
                thumbnail_object_key=thumb_key,
            )
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    async def mm_direct_file_upload(
        self,
        channel_id: str,
        request: Request,
        filename: str,
        api_key: str = Security(api_key_header),
    ) -> MmFileResponse:
        """Accept raw file bytes and perform the R2 upload server-side.

        One-request alternative to the reserve → presigned PUT → confirm
        protocol, for callers whose HTTP egress can't reach the R2 host
        (IronClaw's WASM allowlist only permits the API origin) or that
        want single-call ergonomics (agent CLIs). Because the server holds
        the bytes it also probes image dimensions and generates the 1024px
        thumbnail inline. The row follows the same ``pending`` → R2 PUT →
        ``uploaded`` lifecycle as the presigned flow, so a failed R2
        upload leaves a ``pending`` row (visible to GC) rather than an
        unreferenced R2 object.
        """
        try:
            import hashlib as _hashlib

            cfg = load_file_config()
            if self._mm_r2 is None:
                raise HTTPException(
                    status_code=503,
                    detail="File storage not configured (R2 credentials missing)",
                )

            content_type = request.headers.get("content-type", "application/octet-stream")
            if not is_mime_allowed(content_type, cfg.mime_allowlist):
                raise HTTPException(
                    status_code=415,
                    detail=f"Content type not allowed: {content_type}",
                )
            # Cheap reject before buffering the body when the client
            # declares its size; re-checked on the actual bytes below.
            declared = request.headers.get("content-length")
            if declared is not None and declared.isdigit() and int(declared) > cfg.max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"File too large: {declared} bytes (max {cfg.max_bytes})",
                )

            # Authenticate + authorize before buffering the body — an
            # invalid key or non-member must not cost us max_bytes of RAM.
            agent = self._mm_extract_agent(api_key)
            agent_id = agent.agent_id.value
            with Session(self._engine) as db:
                self._require_mm_member(db, channel_id, agent_id)

            # Stream the body with a hard cap rather than ``request.body()``,
            # which buffers the whole payload unbounded. A chunked upload
            # sends no Content-Length, so the declared-size pre-check above
            # is skipped — this early abort is the only thing that actually
            # bounds memory, capping it at max_bytes + one transport chunk.
            parts: list[bytes] = []
            total = 0
            async for part in request.stream():
                total += len(part)
                if total > cfg.max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File too large: exceeds max {cfg.max_bytes} bytes",
                    )
                parts.append(part)
            data = b"".join(parts)
            if not data:
                raise HTTPException(status_code=400, detail="Empty file body")

            file_id = new_file_id()
            object_key = build_object_key(file_id, filename)

            # Hashing 15 MiB and decoding an image are both CPU-bound —
            # keep the pair off the event loop in one hop.
            def _hash_and_decode() -> tuple[str, tuple[int, int, bytes | None] | None]:
                digest = _hashlib.sha256(data).hexdigest()
                if content_type.lower().startswith("image/"):
                    return digest, decode_image_and_thumbnail(data)
                return digest, None

            sha256, decoded = await asyncio.to_thread(_hash_and_decode)
            width: int | None = None
            height: int | None = None
            thumb: bytes | None = None
            thumb_key: str | None = None
            if decoded is not None:
                width, height, thumb = decoded
                if thumb is not None:
                    thumb_key = build_object_key(file_id, filename, thumbnail=True)

            # Reserve the row *before* the R2 PUT (presigned-flow parity):
            # if the upload dies, the pending row still references the key,
            # so GC can reap it instead of stranding an invisible object.
            with Session(self._engine) as db:
                TableWrite.create_mm_file(
                    db,
                    file_id=file_id,
                    channel_id=channel_id,
                    uploader_agent_id=agent_id,
                    filename=filename,
                    content_type=content_type,
                    size_bytes=len(data),
                    object_key=object_key,
                    thumbnail_object_key=thumb_key,
                    sha256=sha256,
                )
                db.commit()

            result = await self._mm_r2.upload_file(object_key, data, content_type)
            if not result.get("success"):
                raise HTTPException(
                    status_code=502,
                    detail=f"Upload failed: {result.get('error', 'unknown error')}",
                )
            if thumb is not None and thumb_key is not None:
                # Best-effort: a missing thumbnail only costs the client a
                # full-size fetch (``ImageThumb`` falls back to download_url).
                thumb_result = await self._mm_r2.upload_file(
                    thumb_key, thumb, "image/jpeg"
                )
                if not thumb_result.get("success"):
                    logging.warning(
                        "direct upload: thumbnail upload failed for %s: %s",
                        file_id,
                        thumb_result.get("error"),
                    )
                    thumb_key = None

            with Session(self._engine) as db:
                row = TableWrite.confirm_mm_file(
                    db,
                    file_id,
                    uploader_agent_id=agent_id,
                    width=width,
                    height=height,
                    thumbnail_uploaded=thumb_key is not None,
                )
                db.commit()
                return build_file_response(row, presigner=None, ttl=0)
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    async def mm_confirm_file_upload(
        self,
        file_id: str,
        body: MmFileConfirmRequest,
        api_key: str = Security(api_key_header),
    ) -> MmFileResponse:
        """Mark a pending file ``uploaded`` and record optional metadata."""
        try:
            from clawbits.db.models import MmFile as _MmFileRow

            agent = self._mm_extract_agent(api_key)
            agent_id = agent.agent_id.value
            with Session(self._engine) as db:
                try:
                    row = TableWrite.confirm_mm_file(
                        db,
                        file_id,
                        uploader_agent_id=agent_id,
                        width=body.width,
                        height=body.height,
                        duration_ms=body.duration_ms,
                        sha256=body.sha256,
                        thumbnail_uploaded=body.thumbnail_uploaded,
                    )
                except ValueError as e:
                    raise HTTPException(status_code=400, detail=str(e)) from e
                db.commit()
                needs_probe = (
                    row.content_type.startswith("image/")
                    and (row.width is None or row.height is None)
                )
                # Prefer the thumbnail — a small fetch with the original's
                # aspect ratio. Trade-off: the stored width/height are then
                # thumbnail-scale (≤1024), not the original's absolute pixel
                # size; the frontend only needs them for the aspect-ratio
                # box, so approximate absolutes are acceptable.
                probe_key = row.thumbnail_object_key or row.object_key

            # Server-side dimension probe — parity with the human confirm
            # route (see ``human_mm_endpoints.confirm_file_upload``). Agents
            # are typically headless and rarely decode dimensions client-side;
            # without this fallback their image posts render with a 0px-tall
            # slot that reflows on byte arrival. Runs outside the DB context
            # manager because it does network I/O.
            if needs_probe and self._r2_presigner is not None:
                dims = await probe_image_dimensions(self._r2_presigner, probe_key)
                if dims is not None:
                    w, h = dims
                    with Session(self._engine) as db:
                        # Metadata-only write-back: ``thumbnail_uploaded``
                        # stays unset (None) so the client's just-confirmed
                        # thumbnail key is not clobbered.
                        TableWrite.confirm_mm_file(
                            db,
                            file_id,
                            uploader_agent_id=agent_id,
                            width=w,
                            height=h,
                        )
                        db.commit()

            with Session(self._engine) as db:
                # Re-read so the response carries the probed dims.
                row = db.get(_MmFileRow, file_id)
                if row is None:
                    raise HTTPException(status_code=404, detail="file disappeared")
                return build_file_response(row, presigner=None, ttl=0)
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    def mm_get_file_download_url(
        self,
        file_id: str,
        api_key: str = Security(api_key_header),
    ) -> MmFileDownloadUrlResponse:
        """Issue a short-lived presigned GET URL for a file.

        Authz: caller must be a member of the channel the file is
        attached to. Soft-deleted files return 404.
        """
        try:
            cfg = load_file_config()
            presigner = self._require_r2_presigner()

            agent = self._mm_extract_agent(api_key)
            agent_id = agent.agent_id.value

            with Session(self._engine) as db:
                row = TableRead.get_mm_file(db, file_id)
                if row is None:
                    raise HTTPException(status_code=404, detail="File not found")
                if row.status != "uploaded":
                    raise HTTPException(
                        status_code=409,
                        detail=f"File not ready (status={row.status})",
                    )
                self._require_mm_member(db, row.channel_id, agent_id)
                import time as _time

                url, expires_at = cached_presigned_get(
                    presigner,
                    cache_key=f"{row.file_id}:original",
                    object_key=row.object_key,
                    ttl=cfg.download_url_ttl,
                    download_filename=row.filename,
                )
                expires_in = max(0, expires_at - int(_time.time()))
                return MmFileDownloadUrlResponse(
                    url=url, expires_in=expires_in, expires_at=expires_at
                )
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    def mm_delete_file(
        self,
        file_id: str,
        api_key: str = Security(api_key_header),
    ) -> Response:
        """Soft-delete a file owned by the calling agent."""
        try:
            agent = self._mm_extract_agent(api_key)
            agent_id = agent.agent_id.value
            with Session(self._engine) as db:
                row = TableWrite.soft_delete_mm_file(
                    db, file_id, uploader_agent_id=agent_id
                )
                db.commit()
            if row is None:
                raise HTTPException(status_code=404, detail="File not found")
            return Response(status_code=204)
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @cost(1)
    def mm_patch_post(
        self,
        channel_id: str,
        post_id: int,
        body: MmPostPatchRequest,
        api_key: str = Security(api_key_header),
    ) -> MmPostResponse:
        """Stream updates into a streaming post.

        Only the agent that created the post may patch it. Exactly one
        of ``append`` or ``replace`` must be provided per call (``done``
        on its own is valid — e.g. to finalise without changing text).
        Mutual-exclusivity of the fields is enforced by the schema.
        """
        try:
            agent = self._mm_extract_agent(api_key)
            agent_id = agent.agent_id.value
            with Session(self._engine) as db:
                self._require_mm_member(db, channel_id, agent_id)
                # The PATCH path is billing-exempt in the middleware (the
                # streaming lane must be free), so the per-reply charge
                # moves here: finalize (``done``) bills once, in the same
                # transaction as the flip - a 402 leaves the draft open and
                # unbilled. ``cancel`` (no reply produced) stays free, as do
                # the append/replace patches themselves.
                if body.done:
                    try:
                        TableWrite.charge_cb_tokens(
                            db, agent.agent_id, self.AGENTIC_WRITE_CB_TOKENS_COST
                        )
                    except ValueError as exc:
                        if "Insufficient CB_TOKENS" in str(exc):
                            raise HTTPException(status_code=402, detail=str(exc))
                        raise HTTPException(status_code=500, detail=str(exc))
                try:
                    row = TableWrite.patch_mm_post(
                        db,
                        post_id,
                        channel_id,
                        agent_id,
                        append=body.append,
                        replace=body.replace,
                        finalise=body.done,
                        cancel=body.cancel,
                    )
                except LookupError:
                    raise HTTPException(status_code=404, detail="Post not found")
                except PermissionError:
                    raise HTTPException(status_code=403, detail="Not the post owner")
                except ValueError as exc:
                    raise HTTPException(status_code=409, detail=str(exc))
                db.commit()
                if body.cancel:
                    # Streaming row was deleted; no response body. Push the
                    # deletion through the realtime feed so subscribers
                    # drop the now-orphaned shimmer placeholder from their
                    # rendered list (without this, the channel UI keeps
                    # showing the streaming post until the next page
                    # reload). Also flip the agent's presence back to
                    # online so the "generating…" pill un-sticks.
                    from clawbits.realtime import (
                        fire_and_forget,
                        get_bus,
                        publish_member_status,
                        publish_post_deleted,
                    )
                    member_human_ids = (
                        TableRead.get_mm_channel_human_member_ids(db, channel_id)
                    )
                    bus = get_bus()
                    fire_and_forget(
                        publish_post_deleted(
                            bus, channel_id, post_id,
                            member_human_ids=member_human_ids,
                        )
                    )
                    fire_and_forget(
                        bus.presence_set(channel_id, "agent", agent_id, "online")
                    )
                    fire_and_forget(
                        publish_member_status(
                            bus, channel_id, "agent", agent_id, "online"
                        )
                    )
                    return Response(status_code=204)
                resolved_name = (
                    TableRead.resolve_agent_display(db, row.agent_id) if row.agent_id else None
                )
                parent_preview = TableRead.mm_post_parent_preview(db, row.parent_post_id)
                avatar = TableRead._avatar_for_member(db, row.human_id, None, row.agent_id)
                response = MmPostResponse(
                    post_id=row.post_id,
                    channel_id=row.channel_id,
                    agent_id=row.agent_id,
                    human_id=row.human_id,
                    message=row.message,
                    created_at=format_db_timestamp(row.created_at),
                    poster_display_name=resolved_name,
                    avatar=avatar,
                    status=row.status,
                    updated_at=format_db_timestamp(row.updated_at) if row.updated_at else None,
                    parent_post_id=row.parent_post_id,
                    parent_preview=parent_preview,
                )
                # On finalise the streaming row becomes the first publicly
                # visible reply — snapshot the channel's human members so
                # we can fan post.created to their per-user topics for
                # sidebar preview updates.
                finalise_member_human_ids = (
                    TableRead.get_mm_channel_human_member_ids(db, channel_id)
                    if body.done
                    else []
                )
                # Finalise is also where a streamed agent reply first has its
                # real text. Group replies use the streaming-draft flow by
                # default (gateway-adapter's groupChannelShimmer), so this —
                # not create — is where the LobsterTalk attention pass runs for
                # them; mm_create_post covers the published-at-create path and
                # the two can't double-fire (patching a published row 409s).
                from clawbits.lobstertalk.attention import (
                    build_attention_context,
                    consider_post,
                )

                # build_attention_context is the product gate now (org opt-in +
                # eligible agents); it returns None cheaply when the org hasn't
                # armed the feature. Still only run it for a finalised, published
                # reply — a streaming/cancelled row has no real text to consider.
                attention_ctx = (
                    build_attention_context(db, channel_id)
                    if (body.done and row.status == "published")
                    else None
                )

            from clawbits.realtime import (
                fire_and_forget,
                get_bus,
                publish_post_updated_streaming,
            )

            bus = get_bus()
            # Rate-bounded per post while streaming; terminal payloads (the
            # finalize below) always publish immediately. Human edit paths
            # keep the direct publisher.
            fire_and_forget(
                publish_post_updated_streaming(bus, channel_id, response.model_dump())
            )
            if body.done:
                # Finalised agent reply: drive sidebar previews / unread on
                # each member-human's global topic. The per-channel feed
                # already got `post.updated` above and dedupes by post_id.
                from clawbits.realtime import publish_post_created

                fire_and_forget(
                    publish_post_created(
                        bus, channel_id, response.model_dump(),
                        member_human_ids=finalise_member_human_ids,
                    )
                )
                # Reply finished — flip status back to online so the
                # "generating…" pill disappears in the UI.
                from clawbits.realtime import publish_member_status

                fire_and_forget(bus.presence_set(channel_id, "agent", agent_id, "online"))
                fire_and_forget(
                    publish_member_status(bus, channel_id, "agent", agent_id, "online")
                )
                # Server-side LobsterTalk on the finalised text (see the
                # attention_ctx snapshot above): should any *other* channel
                # agent look at this reply? consider_post skips the author and
                # requires inter_agent_mode per candidate.
                if attention_ctx is not None:
                    fire_and_forget(
                        consider_post(
                            post=response.model_dump(),
                            channel_id=channel_id,
                            context=attention_ctx,
                            author_agent_id=agent_id,
                            engine=self._engine,
                        )
                    )
            return response
        except HTTPException:
            raise
        except Exception as e:
            logging.exception(f"Error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # -----------------------------------------------------------------------
    # Email inbox methods (Stalwart IMAP)
    # -----------------------------------------------------------------------

    @cost(1)
    def email_count(
        self, agent_id: str, api_key: str = Security(api_key_header)
    ) -> EmailCountResponse:
        return EmailEndpoints.email_count(self, agent_id, api_key)

    @cost(1)
    def email_inbox(
        self,
        agent_id: str,
        api_key: str = Security(api_key_header),
        limit: int = 50,
        offset: int = 0,
    ) -> EmailListResponse:
        return EmailEndpoints.email_inbox(self, agent_id, api_key, limit, offset)

    @cost(1)
    def email_detail(
        self, agent_id: str, message_uid: int, api_key: str = Security(api_key_header)
    ) -> EmailDetailResponse:
        return EmailEndpoints.email_detail(self, agent_id, message_uid, api_key)

    @cost(1)
    def email_delete(
        self,
        agent_id: str,
        message_uid: int,
        api_key: str = Security(api_key_header),
    ) -> dict:
        return EmailEndpoints.email_delete(self, agent_id, message_uid, api_key)

    @cost(1)
    def email_send(
        self,
        agent_id: str,
        body: EmailSendRequest,
        api_key: str = Security(api_key_header),
    ) -> EmailSendResponse:
        return EmailEndpoints.email_send(self, agent_id, body, api_key)

    # -----------------------------------------------------------------------
    # Git repository methods
    # -----------------------------------------------------------------------

    @cost(1)
    def git_create_repo(
        self,
        agent_id: str,
        body: CreateRepoRequest,
        api_key: str = Security(api_key_header),
    ) -> RepoResponse:
        return GitEndpoints.create_repo(self, agent_id, body, api_key)

    @cost(1)
    def git_list_repos(
        self, agent_id: str, api_key: str = Security(api_key_header)
    ) -> RepoListResponse:
        return GitEndpoints.list_repos(self, agent_id, api_key)

    @cost(1)
    def git_list_commits(
        self,
        agent_id: str,
        repo_name: str,
        api_key: str = Security(api_key_header),
        branch: str = "main",
        limit: int = 50,
        offset: int = 0,
    ) -> CommitListResponse:
        return GitEndpoints.list_commits(self, agent_id, repo_name, api_key, branch, limit, offset)

    @cost(1)
    def git_list_tree(
        self,
        agent_id: str,
        repo_name: str,
        api_key: str = Security(api_key_header),
        ref: str = "main",
        path: str = "",
    ) -> TreeResponse:
        return GitEndpoints.list_tree(self, agent_id, repo_name, api_key, ref, path)

    @cost(1)
    def git_read_blob(
        self,
        agent_id: str,
        repo_name: str,
        file_path: str,
        api_key: str = Security(api_key_header),
        ref: str = "main",
    ) -> BlobResponse:
        return GitEndpoints.read_blob(self, agent_id, repo_name, file_path, api_key, ref)

    @cost(1)
    def git_create_commit(
        self,
        agent_id: str,
        repo_name: str,
        body: CreateCommitRequest,
        api_key: str = Security(api_key_header),
    ) -> CommitResponse:
        return GitEndpoints.create_commit(self, agent_id, repo_name, body, api_key)

    # ------------------------------------------------------------------
    # Agent Action Registry methods
    # ------------------------------------------------------------------

    @cost(1)
    def put_action(
        self,
        agent_id: str,
        body: PutActionRequest,
        api_key: str = Security(api_key_header),
    ) -> ActionResponse:
        """Create or update an action document for an agent."""
        if not api_key or not api_key.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Invalid or missing bearer token")
        token = api_key.split(" ", 1)[1].strip()

        with Session(self._engine) as db:
            agent = TableRead.get_agent_by_api_key(db, token)
            if agent is None:
                raise HTTPException(status_code=401, detail="Invalid API key")
        if agent.agent_id.value != agent_id:
            raise HTTPException(status_code=403, detail="API key does not belong to this agent")

        with Session(self._engine) as db:
            TableWrite.upsert_agent_action(db, agent_id, body.action_id, body.action_md)
            db.commit()

        with Session(self._engine) as db:
            row = TableRead.get_agent_action(db, agent_id, body.action_id)

        return ActionResponse(**row)

    def get_agent_actions(
        self,
        agent_id: str,
        api_key: str = Security(api_key_header),
        limit: int = 100,
        offset: int = 0,
    ) -> AgentActionsResponse:
        """Get all action documents for a specific agent."""
        if not api_key or not api_key.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Invalid or missing bearer token")
        token = api_key.split(" ", 1)[1].strip()

        with Session(self._engine) as db:
            agent = TableRead.get_agent_by_api_key(db, token)
            if agent is None:
                raise HTTPException(status_code=401, detail="Invalid API key")
            items = TableRead.get_agent_actions(db, agent_id, limit=limit, offset=offset)
            total = TableRead.count_agent_actions_for_agent(db, agent_id)

        return AgentActionsResponse(
            agent_id=agent_id,
            actions=[ActionListItem(**i) for i in items],
            total=total,
        )

    def get_action(
        self,
        agent_id: str,
        action_id: str,
        api_key: str = Security(api_key_header),
    ) -> ActionResponse:
        """Get a specific action document for an agent."""
        if not api_key or not api_key.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Invalid or missing bearer token")
        token = api_key.split(" ", 1)[1].strip()

        with Session(self._engine) as db:
            agent = TableRead.get_agent_by_api_key(db, token)
            if agent is None:
                raise HTTPException(status_code=401, detail="Invalid API key")
            row = TableRead.get_agent_action(db, agent_id, action_id)

        if row is None:
            raise HTTPException(
                status_code=404, detail="No action document found with this ID for this agent"
            )
        return ActionResponse(**row)

    @cost(1)
    def delete_action(
        self,
        agent_id: str,
        action_id: str,
        api_key: str = Security(api_key_header),
    ) -> dict:
        """Delete a specific action document for an agent."""
        if not api_key or not api_key.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Invalid or missing bearer token")
        token = api_key.split(" ", 1)[1].strip()

        with Session(self._engine) as db:
            agent = TableRead.get_agent_by_api_key(db, token)
            if agent is None:
                raise HTTPException(status_code=401, detail="Invalid API key")
        if agent.agent_id.value != agent_id:
            raise HTTPException(status_code=403, detail="API key does not belong to this agent")

        with Session(self._engine) as db:
            deleted = TableWrite.delete_agent_action(db, agent_id, action_id)
            db.commit()

        if not deleted:
            raise HTTPException(
                status_code=404, detail="No action document found with this ID for this agent"
            )
        return {"detail": "Action document deleted"}

    def list_actions(
        self,
        api_key: str = Security(api_key_header),
        limit: int = 100,
        offset: int = 0,
    ) -> ActionListResponse:
        """List all action documents across all agents."""
        if not api_key or not api_key.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Invalid or missing bearer token")
        token = api_key.split(" ", 1)[1].strip()

        with Session(self._engine) as db:
            agent = TableRead.get_agent_by_api_key(db, token)
            if agent is None:
                raise HTTPException(status_code=401, detail="Invalid API key")
            items = TableRead.list_agent_actions(db, limit=limit, offset=offset)
            total = TableRead.count_agent_actions(db)

        return ActionListResponse(
            actions=[ActionListItem(**i) for i in items],
            total=total,
        )

    # ------------------------------------------------------------------
    # Agent Profile
    # ------------------------------------------------------------------

    @cost(1)
    def put_agent_profile(
        self,
        agent_id: str,
        body: PutAgentProfileRequest,
        api_key: str = Security(api_key_header),
    ) -> AgentProfileResponse:
        """Create or update an agent's public profile."""
        if not api_key or not api_key.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Invalid or missing bearer token")
        token = api_key.split(" ", 1)[1].strip()

        with Session(self._engine) as db:
            agent = TableRead.get_agent_by_api_key(db, token)
            if agent is None:
                raise HTTPException(status_code=401, detail="Invalid API key")
        if agent.agent_id.value != agent_id:
            raise HTTPException(status_code=403, detail="API key does not belong to this agent")

        with Session(self._engine) as db:
            TableWrite.upsert_agent_profile(
                db,
                agent_id,
                display_name=body.display_name,
                bio=body.bio,
                location=body.location,
                website=body.website,
                avatar_url=body.avatar_url,
                header_url=body.header_url,
            )
            db.commit()

        with Session(self._engine) as db:
            row = TableRead.get_agent_profile(db, agent_id)

        return AgentProfileResponse(**row)

    @cost(1)
    def put_agent_description(
        self,
        agent_id: str,
        body: PutAgentDescriptionRequest,
        api_key: str = Security(api_key_header),
    ) -> AgentDescriptionResponse:
        """Agent self-updates its own auto-generated description.

        The agent produces a short "what people use me for" summary from its
        own activity and pushes it here; we store it (truncated), stamp it as
        ``auto``, and clear any pending owner regenerate request. Other profile
        fields are left untouched.
        """
        if not api_key or not api_key.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Invalid or missing bearer token")
        token = api_key.split(" ", 1)[1].strip()

        with Session(self._engine) as db:
            agent = TableRead.get_agent_by_api_key(db, token)
            if agent is None:
                raise HTTPException(status_code=401, detail="Invalid API key")
        if agent.agent_id.value != agent_id:
            raise HTTPException(status_code=403, detail="API key does not belong to this agent")

        with Session(self._engine) as db:
            TableWrite.set_agent_description(db, agent_id, body.description, source="auto")
            db.commit()
            row = TableRead.get_agent_profile(db, agent_id) or {}

        return AgentDescriptionResponse(
            agent_id=agent_id,
            description=row.get("description"),
            description_generated_at=row.get("description_generated_at"),
            description_source=row.get("description_source"),
        )

    def get_agent_profile(
        self,
        agent_id: str,
        api_key: str = Security(api_key_header),
    ) -> AgentProfileResponse:
        """Get an agent's public profile."""

        if not api_key or not api_key.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Invalid or missing bearer token")
        token = api_key.split(" ", 1)[1].strip()

        with Session(self._engine) as db:
            agent = TableRead.get_agent_by_api_key(db, token)
            if agent is None:
                raise HTTPException(status_code=401, detail="Invalid API key")
            row = TableRead.get_agent_profile(db, agent_id)

        if row is None:
            # Return empty profile with just the agent_id
            return AgentProfileResponse(agent_id=agent_id)
        return AgentProfileResponse(**row)

    def shutdown(self) -> None:
        if self._engine is not None:
            self._engine.dispose()
            self._engine = None
        print("Clawbits server is shutting down...")

    @staticmethod
    def configureLogging():
        root = logging.getLogger()
        root.setLevel(logging.INFO)

        handler = logging.StreamHandler()
        formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
        handler.setFormatter(formatter)

        root.handlers.clear()
        root.addHandler(handler)
