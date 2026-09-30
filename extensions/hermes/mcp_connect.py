"""Sign in to OAuth MCP servers from a Clawbits chat, with the PKCE session kept on disk.

Hermes's own MCP OAuth waits on a loopback callback that nobody reaches in a hosted gateway, so in
a Clawbits chat the plugin runs the authorization-code grant itself, in two halves around the
Connect card Clawbits draws:

- :func:`start_sign_in` (the ``clawbits_mcp_connect`` tool) discovers the server's authorization
  server, registers a client whose redirect is Clawbits's callback and keeps the PKCE verifier in
  the profile; Clawbits turns the sign-in URL into the card the tool posts.
- :func:`redeem` (an ``mcp.oauth.code`` event) exchanges the relayed code with that verifier,
  stores the tokens where Hermes's MCP client reads and refreshes them (``HermesTokenStorage``),
  adds the server to ``mcp_servers`` and connects it.

The session outlives restarts and late clicks: only a success or a newer sign-in for the same
server replaces it. Clawbits binds each click to the human who made it and swaps its own ``state``
into the URL, so the provider's state is Clawbits's to check, not ours. Hermes and MCP SDK modules
are imported inside functions: the plugin must load without them.
"""

from __future__ import annotations

import asyncio
import contextvars
import importlib.util
import json
import logging
import re
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

from .account import _routed, bound_account
from .cli_client import ClawbitsCliError, _ClawbitsCli
from .health import state_dir
from .manifest import PLUGIN_VERSION

logger = logging.getLogger(__name__)

TOOL_NAME = "clawbits_mcp_connect"
PENDING_FILE = "mcp-sign-ins.json"
SERVER_NAME = re.compile(r"\w[\w.-]{0,99}")
# How long a reply waits for a signed-in server to connect before saying it still is.
CONNECT_WAIT_S = 20.0
# Test seam: an httpx2 transport for every OAuth request.
transport: Any = None

_GRANT_TYPES = ("authorization_code", "refresh_token")
_HTTP_TIMEOUT_S = 15.0
_PENDING_TTL_S = 24 * 3600
_LOOPBACK = frozenset({"localhost", "127.0.0.1", "::1"})
_USER_AGENT = f"clawbits-hermes-plugin/{PLUGIN_VERSION}"
# Any MCP request answers 401 without credentials on a server that wants OAuth; only the status matters.
_PROBE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "clawbits-hermes-plugin", "version": PLUGIN_VERSION},
    },
}
_HERMES_SIGN_IN = re.compile(
    r"\bhermes\s+mcp\s+(?:login|reauth)\b|\bhermes\s+mcp\s+add\b[^;&|\n]*--auth[=\s]+oauth\b"
)
_GUARD = (
    f"In Clawbits, sign in to MCP servers with the {TOOL_NAME} tool: a sign-in started here "
    "returns to a localhost callback that cannot reach you."
)
_LOCK = threading.Lock()


class SignInError(RuntimeError):
    """A sign-in that cannot go on; ``str()`` is safe to show the agent and the user."""


@dataclass(frozen=True)
class RelayedCode:
    """A provider's code, relayed by Clawbits from the Connect card a human clicked."""

    server: str
    code: str
    state: str
    channel_id: str
    human_id: int


def relayed_code(data: Any) -> RelayedCode | None:
    """The ``mcp.oauth.code`` event's payload; None when it is malformed."""
    if not isinstance(data, dict):
        return None
    server, code, state, human_id = (data.get(k) for k in ("server", "code", "state", "human_id"))
    if not (
        isinstance(server, str) and SERVER_NAME.fullmatch(server)
        and isinstance(code, str) and code and isinstance(state, str) and state
        and type(human_id) is int
    ):
        return None
    channel_id = data.get("channel_id")
    return RelayedCode(server, code, state, channel_id if isinstance(channel_id, str) else "", human_id)


# --- pending sign-ins -----------------------------------------------------------


def _pending_path() -> Path:
    return state_dir() / PENDING_FILE


def _read_pending() -> dict[str, dict[str, Any]]:
    try:
        raw = json.loads(_pending_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in raw.items() if isinstance(v, dict)} if isinstance(raw, dict) else {}


def _write_pending(entries: dict[str, dict[str, Any]]) -> None:
    from utils import atomic_json_write

    path = _pending_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    atomic_json_write(path, entries, indent=None, mode=0o600)


def _keep_pending(server: str, entry: dict[str, Any]) -> None:
    """Record ``server``'s sign-in, replacing its older one and dropping any left for a day."""
    with _LOCK:
        cutoff = time.time() - _PENDING_TTL_S
        entries = {k: v for k, v in _read_pending().items() if v.get("created_at", 0) > cutoff}
        entries[server] = entry
        _write_pending(entries)


def _drop_pending(server: str, verifier: str) -> None:
    """Forget ``server``'s sign-in unless a newer one replaced it meanwhile."""
    with _LOCK:
        entries = _read_pending()
        if entries.get(server, {}).get("code_verifier") == verifier:
            del entries[server]
            _write_pending(entries)


# --- Hermes's side: config, token storage, live servers ----------------------------


def _server_config(server: str) -> dict[str, Any]:
    from hermes_cli.config import load_config

    servers = load_config().get("mcp_servers")
    entry = servers.get(server) if isinstance(servers, dict) else None
    return dict(entry) if isinstance(entry, dict) else {}


def _save_server(server: str, url: str, *, oauth: bool, scope: str | None = None) -> None:
    """Point ``mcp_servers.<server>`` at ``url``, keeping its other settings. No redirect is
    written: Hermes reads the registered one from the stored client, and a configured one would
    make it park a loopback port for a callback that never comes."""
    from hermes_cli.config import load_config, save_config

    config = load_config()
    servers = config.get("mcp_servers")
    servers = servers if isinstance(servers, dict) else {}
    prev = servers.get(server) if isinstance(servers.get(server), dict) else {}
    entry = {k: v for k, v in prev.items() if k not in ("command", "args", "env", "url", "auth", "oauth")}
    entry["url"] = url
    if oauth:
        prev_oauth = prev.get("oauth") if isinstance(prev.get("oauth"), dict) else {}
        settings = {k: v for k, v in prev_oauth.items() if k not in ("redirect_uri", "redirect_host")}
        if scope:
            settings["scope"] = scope
        entry["auth"] = "oauth"
        if settings:
            entry["oauth"] = settings
    servers[server] = entry
    config["mcp_servers"] = servers
    save_config(config)


async def _stored_access_token(server: str, url: str) -> str | None:
    """The unexpired access token Hermes keeps for ``server``, if it is configured at ``url``."""
    from tools.mcp_oauth import HermesTokenStorage

    if _server_config(server).get("url") != url:
        return None
    token = await HermesTokenStorage(server).get_tokens()
    if token is None or not token.access_token or token.expires_in == 0:
        return None
    return token.access_token


async def _store(server: str, client_info: Any, metadata: Any, token: Any) -> None:
    """Hand the grant to Hermes: tokens last, since their file's new mtime is what makes a live
    server reload its credentials. The issuer stamp is the one Hermes binds refreshes to."""
    from tools.mcp_oauth import HermesTokenStorage

    storage = HermesTokenStorage(server)
    storage.bind_issuer(str(metadata.issuer).rstrip("/"))
    await storage.set_client_info(client_info)
    storage.save_oauth_metadata(metadata)
    await storage.set_tokens(token)


def _connect(server: str, outcome: dict[str, str]) -> None:
    from tools.mcp_oauth import suppress_interactive_oauth
    from tools.mcp_tool_discovery import reconcile_mcp_servers_with_config
    from tools.mcp_tool_loop import reconnect_mcp_server

    with suppress_interactive_oauth():
        if reconnect_mcp_server(server):
            outcome["status"] = "its tools are in your tool list by your next turn at the latest."
            return
        added = server in reconcile_mcp_servers_with_config().get("added", [])
    outcome["status"] = (
        "its tools are in your tool list from your next turn." if added
        else "but it has not connected yet; the gateway retries it, and its tools join your tool list once it does."
    )


def connect_server(server: str, wait: float = CONNECT_WAIT_S) -> str:
    """Bring ``server`` up now rather than at the gateway's next reconcile; the note for the agent.
    A served profile is left to that reconcile, which runs inside its runtime scope."""
    pending = "its tools join your tool list once the gateway connects it, within a minute."
    if _routed():
        return pending
    outcome: dict[str, str] = {}

    def run() -> None:
        try:
            _connect(server, outcome)
        except Exception:
            logger.warning("clawbits: connecting MCP server %s failed", server, exc_info=True)

    thread = threading.Thread(
        target=contextvars.copy_context().run, args=(run,), daemon=True, name=f"clawbits-mcp-{server}"
    )
    thread.start()
    thread.join(wait)
    return outcome.get("status", pending)


# --- the OAuth grant -----------------------------------------------------------------


def _secure(url: str, what: str) -> str:
    """``url`` if it is https, or http on this machine's loopback."""
    parts = urlsplit(url)
    if (parts.scheme == "https" and parts.hostname) or (parts.scheme == "http" and parts.hostname in _LOOPBACK):
        return url
    raise SignInError(f"the {what} must be an https URL (got {parts.scheme or 'no'} scheme)")


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def _client() -> Any:
    import httpx2

    return httpx2.AsyncClient(timeout=_HTTP_TIMEOUT_S, transport=transport, headers={"User-Agent": _USER_AGENT})


async def _probe(client: Any, url: str, token: str | None = None) -> Any:
    """POST an ``initialize`` and keep only the status and headers: a streamed reply is never read."""
    headers = {"Accept": "application/json, text/event-stream"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    async with client.stream("POST", url, json=_PROBE, headers=headers) as response:
        return response


async def _get(client: Any, url: str) -> Any:
    from mcp.client.auth.utils import create_oauth_metadata_request

    return await client.send(create_oauth_metadata_request(_secure(url, "metadata URL")), follow_redirects=True)


async def _discover(client: Any, url: str, challenge: Any) -> tuple[Any, Any, str]:
    """The protected-resource metadata (or None), the authorization server's metadata and the
    issuer credentials bind to, as the MCP SDK discovers them (RFC 9728, then RFC 8414)."""
    from mcp.client.auth.utils import (
        build_oauth_authorization_server_metadata_discovery_urls,
        build_protected_resource_metadata_discovery_urls,
        extract_resource_metadata_from_www_auth,
        handle_auth_metadata_response,
        handle_protected_resource_response,
        validate_metadata_issuer,
    )
    from mcp.shared.auth_utils import check_resource_allowed, resource_url_from_server_url

    prm = auth_server = None
    hint = extract_resource_metadata_from_www_auth(challenge)
    for candidate in build_protected_resource_metadata_discovery_urls(hint, url):
        prm = await handle_protected_resource_response(await _get(client, candidate))
        if prm is not None:
            if not check_resource_allowed(resource_url_from_server_url(url), str(prm.resource)):
                raise SignInError(f"the server's metadata names another resource ({prm.resource})")
            auth_server = str(prm.authorization_servers[0])
            break
    metadata = None
    for candidate in build_oauth_authorization_server_metadata_discovery_urls(auth_server, url):
        ok, found = await handle_auth_metadata_response(await _get(client, candidate))
        if not ok:
            break
        if found is not None:
            if auth_server is not None:
                validate_metadata_issuer(found, auth_server)
            metadata = found
            break
    if metadata is None:
        raise SignInError("the server names no OAuth authorization server it can be signed in with")
    _secure(str(metadata.authorization_endpoint), "authorization endpoint")
    _secure(str(metadata.token_endpoint), "token endpoint")
    return prm, metadata, auth_server or str(metadata.issuer)


async def _registration(
    client: Any, server: str, url: str, redirect_uri: str, scope: str | None, metadata: Any, issuer: str
) -> Any:
    """The client to sign in as: one set in config, the one registered for this redirect before, or
    a new dynamic registration (RFC 7591) bound to ``issuer`` the way the MCP SDK binds it."""
    from mcp.client.auth import OAuthRegistrationError
    from mcp.client.auth.oauth2 import check_registration_usable
    from mcp.client.auth.utils import (
        create_client_registration_request,
        handle_registration_response,
    )
    from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata
    from tools.mcp_oauth import HermesTokenStorage

    settings = _server_config(server).get("oauth")
    settings = settings if isinstance(settings, dict) else {}
    if settings.get("client_id"):
        if settings.get("redirect_port"):
            raise SignInError(
                f"its OAuth client in config.yaml is registered for a localhost callback; register "
                f"{redirect_uri} for it and drop mcp_servers.{server}.oauth.redirect_port"
            )
        secret = settings.get("client_secret") or None
        return OAuthClientInformationFull(
            client_id=str(settings["client_id"]),
            client_secret=secret,
            token_endpoint_auth_method=settings.get("token_endpoint_auth_method")
            or ("client_secret_post" if secret else "none"),
            redirect_uris=[redirect_uri],
            grant_types=list(_GRANT_TYPES),
            scope=scope,
        )
    stored = await HermesTokenStorage(server).get_client_info()
    if (
        stored is not None
        and stored.issuer == issuer
        and [str(uri) for uri in stored.redirect_uris or ()] == [redirect_uri]
        and not (stored.client_secret_expires_at and stored.client_secret_expires_at < time.time())
    ):
        return stored
    base = _origin(url)
    if metadata.registration_endpoint is not None:
        _secure(str(metadata.registration_endpoint), "registration endpoint")
    request = create_client_registration_request(
        metadata,
        OAuthClientMetadata(
            client_name="Hermes Agent",
            redirect_uris=[redirect_uri],
            grant_types=list(_GRANT_TYPES),
            response_types=["code"],
            token_endpoint_auth_method="none",
            scope=scope,
            application_type="web",
        ),
        base,
    )
    try:
        info = await handle_registration_response(await client.send(request))
    except OAuthRegistrationError:
        raise SignInError(
            f"its authorization server does not let clients register themselves; set "
            f"mcp_servers.{server}.oauth.client_id (and client_secret) to an OAuth app whose "
            f"redirect is {redirect_uri}"
        )
    check_registration_usable(info)
    if metadata.registration_endpoint is not None or _origin(issuer) == base:
        info.issuer = issuer
    return info


async def start_sign_in(server: str, url: str, scope: str | None, redirect_uri: str) -> str | None:
    """Begin signing ``server`` in: the provider's sign-in URL, its PKCE session kept for
    :func:`finish_sign_in`. None when there is nothing to sign in — the server answers without
    credentials, or with the token already stored for it — and it has joined ``mcp_servers``."""
    import httpx2
    from mcp.client.auth import OAuthFlowError, PKCEParameters
    from mcp.client.auth.utils import extract_scope_from_www_auth, get_client_metadata_scopes
    from mcp.shared.auth_utils import check_resource_allowed, resource_url_from_server_url

    _secure(url, "server url")
    host = urlsplit(url).netloc
    try:
        async with _client() as client:
            token = await _stored_access_token(server, url)
            if token and (await _probe(client, url, token)).is_success:
                _save_server(server, url, oauth=True, scope=scope)
                return None
            challenge = await _probe(client, url)
            if challenge.is_success:
                _save_server(server, url, oauth=False)
                return None
            if challenge.status_code != 401:
                raise SignInError(
                    f"{host} did not answer as an MCP server (HTTP {challenge.status_code}); check its url"
                )
            prm, metadata, issuer = await _discover(client, url, challenge)
            requested = scope
            scope = scope or get_client_metadata_scopes(
                extract_scope_from_www_auth(challenge), prm, metadata, list(_GRANT_TYPES)
            )
            info = await _registration(client, server, url, redirect_uri, scope, metadata, issuer)
    except httpx2.HTTPError as exc:
        raise SignInError(f"could not reach {host} or its authorization server ({type(exc).__name__})")
    except OAuthFlowError as exc:
        raise SignInError(str(exc)[:300])
    pkce = PKCEParameters.generate()
    params = {
        "response_type": "code",
        "client_id": info.client_id,
        "redirect_uri": redirect_uri,
        "state": secrets.token_urlsafe(32),
        "code_challenge": pkce.code_challenge,
        "code_challenge_method": "S256",
    }
    resource = None
    if prm is not None:  # RFC 8707, as the MCP SDK sends it
        resource = resource_url_from_server_url(url)
        if check_resource_allowed(resource, str(prm.resource)):
            resource = str(prm.resource)
        params["resource"] = resource
    if scope:
        params["scope"] = scope
        if "offline_access" in scope.split():
            params["prompt"] = "consent"
    _keep_pending(server, {
        "url": url,
        "redirect_uri": redirect_uri,
        "scope": scope,
        "requested_scope": requested,
        "code_verifier": pkce.code_verifier,
        "resource": resource,
        "client": info.model_dump(mode="json", exclude_none=True),
        "metadata": metadata.model_dump(mode="json", exclude_none=True),
        "created_at": time.time(),
    })
    endpoint = str(metadata.authorization_endpoint)
    return f"{endpoint}{'&' if '?' in endpoint else '?'}{urlencode(params)}"


def _token_auth(info: Any, data: dict[str, str]) -> tuple[dict[str, str], dict[str, str]]:
    """The token request's client authentication (RFC 6749 §2.3.1), as the MCP SDK applies it."""
    from mcp.client.auth.oauth2 import OAuthContext

    context = OAuthContext(
        server_url="", client_metadata=None, storage=None, redirect_handler=None, callback_handler=None
    )
    context.client_info = info
    return context.prepare_token_auth(data, {"Content-Type": "application/x-www-form-urlencoded"})


def _oauth_error(response: Any) -> str:
    try:
        body = response.json()
    except ValueError:
        body = None
    error = body.get("error") if isinstance(body, dict) else None
    shown = isinstance(error, str) and error.isprintable()
    return f"HTTP {response.status_code}" + (f", {error[:64]}" if shown else "")


async def finish_sign_in(server: str, code: str) -> None:
    """Exchange ``code`` with ``server``'s kept PKCE session and hand the grant to Hermes. The
    session stays for another try unless the exchange succeeded. Like ``openclaw mcp login
    --code``, only the code is redeemed: Clawbits relays no ``iss`` (RFC 9207), and the code is
    bound to this session's verifier and token endpoint either way."""
    import httpx2
    from mcp.client.auth import OAuthFlowError
    from mcp.client.auth.utils import handle_token_response_scopes
    from mcp.shared.auth import OAuthClientInformationFull, OAuthMetadata

    pending = _read_pending().get(server)
    if pending is None:
        raise SignInError("no sign-in is waiting for it here; ask for a new Connect card")
    metadata = OAuthMetadata.model_validate(pending["metadata"])
    info = OAuthClientInformationFull.model_validate(pending["client"])
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": pending["redirect_uri"],
        "client_id": info.client_id,
        "code_verifier": pending["code_verifier"],
    }
    if pending.get("resource"):
        data["resource"] = pending["resource"]
    try:
        data, headers = _token_auth(info, data)
        async with _client() as client:
            response = await client.post(str(metadata.token_endpoint), data=data, headers=headers)
            if not response.is_success:
                raise SignInError(f"the authorization server refused the code ({_oauth_error(response)})")
            token = await handle_token_response_scopes(response)
    except httpx2.HTTPError as exc:
        raise SignInError(f"could not reach the authorization server ({type(exc).__name__})")
    except OAuthFlowError as exc:
        raise SignInError(str(exc)[:300])
    if token.scope is None:
        token.scope = pending.get("scope")
    await _store(server, info, metadata, token)
    _save_server(server, pending["url"], oauth=True, scope=pending.get("requested_scope"))
    _drop_pending(server, pending["code_verifier"])


async def redeem(client: _ClawbitsCli, relayed: RelayedCode) -> str:
    """Finish a relayed sign-in and report it to Clawbits, whose card shows the outcome; the note
    telling the agent what happened. A failure leaves the card open for another click."""
    try:
        await finish_sign_in(relayed.server, relayed.code)
        connected, reason = True, ""
    except SignInError as exc:
        connected, reason = False, str(exc)
    except Exception:
        logger.warning("clawbits: MCP sign-in for %s failed", relayed.server, exc_info=True)
        connected, reason = False, "it could not be completed"
    try:
        await asyncio.to_thread(client.mcp_oauth_result, relayed.state, connected)
    except Exception:
        logger.warning("clawbits: reporting the MCP sign-in for %s failed", relayed.server, exc_info=True)
    name = f'MCP server "{relayed.server}"'
    if not connected:
        return f"[Clawbits] Sign-in to {name} did not finish: {reason}. Its Connect card is open again for another try."
    status = await asyncio.to_thread(connect_server, relayed.server)
    return f"[Clawbits] Signed in to {name}; {status}"


# --- the tool and its guard -------------------------------------------------------------


MCP_CONNECT_SCHEMA = {
    "name": TOOL_NAME,
    "description": (
        "Sign in to an OAuth MCP server (Linear, Notion, AgentPit and the like) so its tools become "
        "yours. Posts a Connect card in this Clawbits chat; the user signs in from it and you get a "
        "message when the sign-in finishes. Use it instead of `hermes mcp login` or `hermes mcp add "
        "--auth oauth`, whose localhost callback cannot reach you here. Returns card_posted, or "
        "signed_in when the server needs no sign-in."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "server": {"type": "string", "description": "MCP server name, such as linear.", "pattern": r"^\w[\w.-]{0,99}$"},
            "url": {"type": "string", "description": "The server's MCP endpoint, such as https://mcp.linear.app/mcp."},
            "scope": {"type": "string", "description": "OAuth scope, when the server asks for one."},
        },
        "required": ["server", "url"],
    },
}


def available() -> bool:
    """The profile's Clawbits gateway is running (its code arrives there) and Hermes has MCP."""
    try:
        return bound_account() is not None and all(
            importlib.util.find_spec(name) is not None for name in ("mcp", "httpx2")
        )
    except Exception:
        return False


def _clawbits_chat() -> str | None:
    """The Clawbits channel this turn answers in, if it does."""
    from gateway.session_context import get_session_env

    if get_session_env("HERMES_SESSION_PLATFORM") != "clawbits":
        return None
    return get_session_env("HERMES_SESSION_CHAT_ID") or None


def _run(coroutine: Any) -> Any:
    """Run ``coroutine`` to completion from sync code, on a thread of its own if this one has a loop."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coroutine)
    with ThreadPoolExecutor(1) as pool:
        return pool.submit(contextvars.copy_context().run, asyncio.run, coroutine).result()


def _tool_error(message: str, code: str) -> str:
    return json.dumps({"error": message, "code": code})


def mcp_connect_tool(args: dict[str, Any], **_: Any) -> str:
    """Post a Connect card for ``args.server`` in this chat; ``{status}`` or ``{error, code}``."""
    account = bound_account()
    if account is None:
        return _tool_error("The Clawbits gateway is not running for this profile", "clawbits_unavailable")
    channel_id = _clawbits_chat()
    if channel_id is None:
        return _tool_error(f"{TOOL_NAME} works only while answering in a Clawbits chat.", "not_in_clawbits_chat")
    server, url, scope = args.get("server"), args.get("url"), args.get("scope")
    if not (isinstance(server, str) and SERVER_NAME.fullmatch(server)):
        return _tool_error("server must be a name like linear", "invalid_server")
    if not (isinstance(url, str) and url.strip()):
        return _tool_error("url must be the server's MCP endpoint", "invalid_url")
    scope = scope.strip() if isinstance(scope, str) and scope.strip() else None
    client = _ClawbitsCli.for_account(account)
    try:
        redirect_uri = client.mcp_oauth_redirect()
        authorize_url = _run(start_sign_in(server, url.strip(), scope, redirect_uri))
        if authorize_url is None:
            return json.dumps({"status": "signed_in", "detail": connect_server(server)})
        link = client.mcp_oauth_link(server, authorize_url, channel_id)
        client.post_message(channel_id, link)
    except SignInError as exc:
        return _tool_error(f"Could not start the sign-in to {server}: {exc}", "sign_in_failed")
    except ClawbitsCliError as exc:
        logger.warning("clawbits: MCP connect for %s failed (%s)", server, exc.code)
        return _tool_error("Clawbits could not post the Connect card", exc.code)
    except Exception:
        logger.warning("clawbits: MCP connect for %s failed", server, exc_info=True)
        return _tool_error(f"Could not start the sign-in to {server}", "sign_in_failed")
    return json.dumps({"status": "card_posted"})


def guard_sign_in(tool_name: str = "", args: Any = None, **_: Any) -> dict[str, str] | None:
    """``pre_tool_call``: in a Clawbits chat, block Hermes's own MCP sign-ins, whose localhost
    callback never reaches a hosted gateway, in favour of the Connect card."""
    try:
        if _clawbits_chat() is None:
            return None
    except ImportError:
        return None
    args = args if isinstance(args, dict) else {}
    if tool_name == "terminal" and _HERMES_SIGN_IN.search(str(args.get("command") or "")):
        return {"action": "block", "message": _GUARD}
    if tool_name == "manage_connections" and args.get("action") == "authorize":
        return {"action": "block", "message": _GUARD}
    return None
