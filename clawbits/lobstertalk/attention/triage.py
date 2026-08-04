"""LLM triage: the cascade's confirm stage (run after an embedding-gate pass)
and llm_only mode's sole filter (run on every post, no gate in front).

The gate (:mod:`clawbits.lobstertalk.attention.gate`) is the cheap recall
pre-filter; this module is the precision stage, ported from the deleted
standalone sidecar's decision engine. It asks a per-org-configured
OpenAI-compatible endpoint one question — given the channel transcript, does
this agent's input look genuinely needed? — and returns a
:class:`TriageDecision`, or None when it couldn't decide (unreachable server,
bad config, unparseable reply). What the caller does with None is mode-owned
(see ``service.consider_post``): cascade fails open to the gate verdict — a
misconfigured LLM can never silently mute agents — while llm_only, with no
verdict to fall back on, fails closed. Every failure path here warns instead
of raising either way.

Portability over strictness: plain ``chat.completions`` with the JSON
instruction embedded in the prompt, parsed by a balanced-brace fallback —
``response_format`` json_schema is deliberately not used because compat
servers (Ollama, Anthropic's compat endpoint, ...) don't agree on it. The
``openai`` SDK is imported lazily inside :func:`_make_client` (matching
gate.py's lazy-import style), so importing this module never requires the
``router`` extra.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from typing import Any

from clawbits.ssrf import (
    PrivateAddressError,
    UnsafeHostError,
    arun_guarded,
    check_host_is_public,
    dialed_host,
    make_guarded_async_client,
    parse_url,
    redact_url,
)

logger = logging.getLogger(__name__)

TRANSCRIPT_CHAR_BUDGET = 8000
MESSAGE_CHAR_LIMIT = 300
TRANSCRIPT_POST_LIMIT = 20
TRIAGE_TIMEOUT_SECONDS = 30.0
DEFAULT_TRIAGE_MAX_TOKENS = 300
# Marks the post that tripped the gate, so the model judges *that* message
# rather than whatever the channel drifted onto.
FOCUS_PREFIX = "*** "


def triage_max_tokens() -> int:
    """Output-token cap for one triage call.

    300 is ample for the verdict itself (a well-behaved reply is ~15 tokens),
    but a *reasoning* model spends this budget thinking first and can hit the
    cap before emitting any content at all — the reply then comes back with an
    empty ``content`` and the thinking in a provider-specific field, which
    reads as "unparseable" and fails the call. Raise
    ``CLAWBITS_ATTENTION_TRIAGE_MAX_TOKENS`` to give such a model room to
    finish, or (cheaper, and what the README recommends) point the org at a
    small non-reasoning model."""
    raw = os.environ.get("CLAWBITS_ATTENTION_TRIAGE_MAX_TOKENS", "").strip()
    try:
        return int(raw) if raw else DEFAULT_TRIAGE_MAX_TOKENS
    except ValueError:
        logger.warning(
            "bad CLAWBITS_ATTENTION_TRIAGE_MAX_TOKENS %r; using %d",
            raw, DEFAULT_TRIAGE_MAX_TOKENS,
        )
        return DEFAULT_TRIAGE_MAX_TOKENS


def _unparseable_hint(choice: object, source: str, content: str) -> str:
    """Short parenthetical naming *why* a reply couldn't be read.

    A blank log line ("unparseable reply: ") is the least actionable thing we
    can print, and it's exactly what a reasoning model produces when it burns
    the token cap while thinking. Name that case so the operator reaches for
    the budget knob or a different model instead of the endpoint config."""
    finish = getattr(choice, "finish_reason", None)
    # Budget first: a reasoning model hits the cap mid-thought, so `content` is
    # empty but we may still have recovered (truncated) reasoning text. Keying
    # this on emptiness would miss exactly the case it exists to explain.
    if finish == "length":
        return (
            " [hit the token cap before producing a verdict — typical of a reasoning "
            "model; raise CLAWBITS_ATTENTION_TRIAGE_MAX_TOKENS or use a non-reasoning "
            "model]"
        )
    if not content:
        return f" [empty reply, finish_reason={finish!r}]"
    if source != "content":
        return f" [read from {source!r}; the model left content empty]"
    return ""


def _reply_text(message: object) -> tuple[str, str]:
    """``(content, source)`` for a chat-completion message.

    Reasoning models put their chain-of-thought in a non-standard sibling
    field (``reasoning`` on Ollama, ``reasoning_content`` elsewhere) and leave
    ``content`` empty when they run out of budget mid-thought. When content is
    empty we look there too: a model that *finished* thinking often states the
    JSON verdict inside its reasoning, which is a correct answer we'd
    otherwise discard."""
    content = (getattr(message, "content", None) or "").strip()
    if content:
        return content, "content"
    for field in ("reasoning", "reasoning_content"):
        value = getattr(message, field, None)
        if isinstance(value, str) and value.strip():
            return value.strip(), field
    return "", "content"


@dataclass(frozen=True)
class LlmTriageConfig:
    """Per-org confirm-stage endpoint; ``api_key`` is already decrypted."""

    base_url: str
    model: str
    api_key: str | None


@dataclass(frozen=True)
class TriageDecision:
    needs_input: bool
    reason: str


def extract_json_object(text: str) -> dict[str, Any] | None:
    """Best-effort parse: whole text, else the first balanced ``{...}`` block.

    Small models sometimes wrap JSON in prose or code fences even when the
    prompt asks for JSON only.
    """
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except ValueError:
        pass
    start = text.find("{")
    while start != -1:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        parsed = json.loads(text[start : i + 1])
                        return parsed if isinstance(parsed, dict) else None
                    except ValueError:
                        break
        start = text.find("{", start + 1)
    return None


def _one_line(value: object) -> str:
    """Flatten untrusted text to a single transcript line.

    Every author-controlled field goes through this — message bodies *and*
    display names. A line break in either would let a user forge extra
    transcript lines, including one prefixed with :data:`FOCUS_PREFIX`,
    pointing the model at a message that never tripped the gate. ``\\n`` alone
    isn't enough: ``\\r``, U+2028 and U+2029 are line breaks to a model reading
    the prompt, and nothing validates them out of a post body or a display
    name.
    """
    text = str(value or "")
    for ch in ("\r\n", "\n", "\r", " ", " ", "\v", "\f", "\x85"):
        text = text.replace(ch, " ")
    return text


def format_transcript(
    posts: list[dict], agent_id: str, focus_post_id: int | None = None
) -> str:
    """Oldest-first transcript, newest kept when the budget forces drops.

    ``posts`` are the dicts ``service._load_transcript`` builds
    (``{post_id, agent_id, human_id, who, message, created_at}``), already
    oldest-first. The candidate agent's own lines are marked ``(this agent)``
    and other agents' ``(agent)`` so the model can tell voices apart, and the
    post that tripped the gate (``focus_post_id``) is prefixed with
    :data:`FOCUS_PREFIX` — without it the model judges the conversation's
    current state and can decline because a *later* message moved on.
    """
    lines: list[str] = []
    for post in posts:
        who = _one_line(post.get("who") or post.get("agent_id") or f"human:{post.get('human_id')}")
        marker = " (this agent)" if post.get("agent_id") == agent_id else (
            " (agent)" if post.get("agent_id") else ""
        )
        message = _one_line(post.get("message")).strip()
        if len(message) > MESSAGE_CHAR_LIMIT:
            message = message[:MESSAGE_CHAR_LIMIT] + "…"
        focus = focus_post_id is not None and post.get("post_id") == focus_post_id
        prefix = FOCUS_PREFIX if focus else ""
        lines.append(f"{prefix}[{post.get('created_at')}] {who}{marker}: {message}")
    kept: list[str] = []
    total = 0
    for line in reversed(lines):
        if total + len(line) + 1 > TRANSCRIPT_CHAR_BUDGET:
            break
        kept.append(line)
        total += len(line) + 1
    return "\n".join(reversed(kept))


def build_system_prompt(agent_id: str, description: str | None) -> str:
    identity = f" Their profile: {description}" if description else ""
    return (
        f"You are a triage assistant for the AI agent '{agent_id}'.{identity}\n"
        "Given a chat-channel transcript, decide whether the agent's input is "
        "genuinely needed right now. The agent already handles @mentions and "
        "direct messages automatically, so those never need you. Answer "
        "needs_input=true only for: an open question squarely in the agent's "
        "competence that nobody is answering, a stalled discussion the agent "
        "can unblock, or an explicit reference to the agent without an "
        "@mention. When unsure, answer needs_input=false. Reply with ONLY a "
        'JSON object {"needs_input": <bool>, "reason": "<one sentence>"}.'
    )


def build_user_prompt(
    channel_label: str, channel_id: str, transcript: str, *, has_focus: bool
) -> str:
    focus_note = (
        f' The line starting with "{FOCUS_PREFIX.strip()}" is the new message '
        "that triggered this check."
        if has_focus
        else ""
    )
    return (
        f'Channel "{channel_label}" ({channel_id}), newest messages last.{focus_note}\n'
        f"{transcript}\n\nDoes the agent need to respond?"
    )


def _allowed_private_hosts() -> frozenset[str]:
    """Hostnames the operator has cleared to be private/loopback or plain
    http — a self-hosted Ollama is the motivating case. Comma-separated in
    ``CLAWBITS_ATTENTION_LLM_ALLOW_HOSTS``; empty by default, because org
    creation is self-serve and the base URL is therefore attacker-choosable."""
    raw = os.environ.get("CLAWBITS_ATTENTION_LLM_ALLOW_HOSTS", "")
    return frozenset(h.strip().lower() for h in raw.split(",") if h.strip())


def check_endpoint_allowed(base_url: str) -> None:
    """Raise :class:`clawbits.ssrf.UnsafeHostError` unless ``base_url`` is a
    safe target: https (or an allowlisted host over http, since a plain-http
    hop would put channel text on the wire in clear), resolving only to
    public addresses (or, again, allowlisted).

    Called both when an owner saves the config — immediate feedback — and
    immediately before every triage call, because the first check alone
    would only constrain what someone is willing to type, not where the name
    points by the time we dial it."""
    parsed = parse_url(base_url)
    host = dialed_host(parsed)
    if not host:
        raise PrivateAddressError("base_url has no host")
    allowed = _allowed_private_hosts()
    if parsed.scheme != "https" and host.lower() not in allowed:
        raise PrivateAddressError(
            f"refusing to send channel text over plain http to {host}; "
            "use https or add the host to CLAWBITS_ATTENTION_LLM_ALLOW_HOSTS"
        )
    check_host_is_public(host, allow_hosts=allowed)


def _make_client(config: LlmTriageConfig):
    """Per-call ``AsyncOpenAI`` client. Module-level so tests can monkeypatch
    it; ``openai`` is imported lazily so the module imports without the
    ``router`` extra. Key-less compat servers (Ollama) still require a
    non-empty ``api_key``, hence the ``"unused"`` placeholder.

    The client comes from :func:`make_guarded_async_client`, which does two
    load-bearing things. It never follows redirects: the SDK's default client
    does, which would let an allowed public endpoint bounce the request — body
    and all — to a private address that :func:`check_endpoint_allowed` just
    cleared it of. And its transport pins the vetted IP, so a name that
    resolves public at check time can't be rebound to a private address for the
    actual dial — the residual the plain resolve-then-connect guard couldn't
    close. The operator allowlist is threaded through so a self-hosted model on
    a private address still connects."""
    from openai import AsyncOpenAI

    return AsyncOpenAI(
        base_url=config.base_url,
        api_key=config.api_key or "unused",
        timeout=TRIAGE_TIMEOUT_SECONDS,
        max_retries=0,
        http_client=make_guarded_async_client(
            allow_hosts=_allowed_private_hosts(),
            timeout=TRIAGE_TIMEOUT_SECONDS,
        ),
    )


async def triage_decide(
    *,
    config: LlmTriageConfig,
    agent_id: str,
    description: str | None,
    channel_id: str,
    channel_label: str,
    posts: list[dict],
    focus_post_id: int | None = None,
) -> TriageDecision | None:
    """One confirm-stage chat turn for one candidate agent.

    None means "could not decide" — the caller falls back to the gate verdict
    (fail open). Every failure path warns with enough context (endpoint,
    model, agent) to diagnose a misconfigured org from the server log.

    The whole thing runs under a single wall-clock deadline. The client's
    ``timeout`` is per socket operation, so a hostile endpoint can hold a
    connection open indefinitely by dribbling one byte just under it, and the
    resolution step ahead of the call has no timeout of its own — neither is
    bounded without this.

    The deadline bounds how long the *caller* waits, which is what the nudge
    path needs. A resolver already blocked in ``getaddrinfo`` can't be
    cancelled, so that thread can outlive the deadline and keeps occupying a
    slot in the default executor.
    """
    try:
        async with asyncio.timeout(TRIAGE_TIMEOUT_SECONDS):
            return await _triage_call(
                config=config,
                agent_id=agent_id,
                description=description,
                channel_id=channel_id,
                channel_label=channel_label,
                posts=posts,
                focus_post_id=focus_post_id,
            )
    except TimeoutError:
        logger.warning(
            "attention triage: timed out after %.0fs for agent=%s (model=%s base_url=%s)",
            TRIAGE_TIMEOUT_SECONDS, agent_id, config.model, redact_url(config.base_url),
        )
        return None


async def _triage_call(
    *,
    config: LlmTriageConfig,
    agent_id: str,
    description: str | None,
    channel_id: str,
    channel_label: str,
    posts: list[dict],
    focus_post_id: int | None,
) -> TriageDecision | None:
    """The request itself. Split out so :func:`triage_decide` is nothing but
    the deadline wrapper."""
    try:
        # Re-checked per call, not just at save time: the name is resolved
        # here, so a config that was safe when stored can't quietly become an
        # internal address later. getaddrinfo blocks, hence the thread.
        try:
            await arun_guarded(check_endpoint_allowed, config.base_url)
        except UnsafeHostError as e:
            logger.warning(
                "attention triage: refusing endpoint for agent=%s (base_url=%s): %s",
                agent_id, redact_url(config.base_url), e,
            )
            return None
        client = _make_client(config)
        try:
            response = await client.chat.completions.create(
                model=config.model,
                messages=[
                    {"role": "system", "content": build_system_prompt(agent_id, description)},
                    {
                        "role": "user",
                        "content": build_user_prompt(
                            channel_label,
                            channel_id,
                            format_transcript(posts, agent_id, focus_post_id),
                            has_focus=focus_post_id is not None,
                        ),
                    },
                ],
                temperature=0,
                max_tokens=triage_max_tokens(),
            )
        finally:
            await client.close()
        choice = response.choices[0] if response.choices else None
        content, source = _reply_text(getattr(choice, "message", None))
        raw = extract_json_object(content)
        if raw is None or not isinstance(raw.get("needs_input"), bool):
            logger.warning(
                "attention triage: unparseable reply for agent=%s (model=%s base_url=%s)%s: %.200s",
                agent_id, config.model, redact_url(config.base_url),
                _unparseable_hint(choice, source, content), content,
            )
            return None
        return TriageDecision(needs_input=raw["needs_input"], reason=str(raw.get("reason", "")))
    except Exception as e:
        logger.warning(
            "attention triage failed for agent=%s (model=%s base_url=%s): %s",
            agent_id, config.model, redact_url(config.base_url), e,
        )
        return None


async def probe_llm_endpoint(config: LlmTriageConfig) -> tuple[bool, str]:
    """One live test call against ``config`` for the settings-page healthcheck.

    Exercises the exact stages a real triage call runs — endpoint guard, dial,
    auth, model, JSON-parseable reply — against a one-line synthetic
    transcript. Returns ``(ok, detail)`` where ``detail`` names the failing
    stage in operator terms (it is rendered verbatim in the settings UI).
    Unlike :func:`triage_decide`, failures are *reported*, not swallowed into
    a fail-open/closed verdict — a healthcheck that hides the reason would be
    this feature's own bug. The caller decides what a failure means; nothing
    here touches nudge delivery."""
    posts = [{
        "post_id": 1, "who": "operator", "human_id": 0, "agent_id": None,
        "created_at": "now",
        "message": "Healthcheck: is this endpoint configured correctly?",
    }]
    try:
        async with asyncio.timeout(TRIAGE_TIMEOUT_SECONDS):
            try:
                await arun_guarded(check_endpoint_allowed, config.base_url)
            except UnsafeHostError as e:
                return False, str(e)
            client = _make_client(config)
            try:
                response = await client.chat.completions.create(
                    model=config.model,
                    messages=[
                        {"role": "system", "content": build_system_prompt("healthcheck", None)},
                        {
                            "role": "user",
                            "content": build_user_prompt(
                                "healthcheck", "healthcheck",
                                format_transcript(posts, "healthcheck", None),
                                has_focus=False,
                            ),
                        },
                    ],
                    temperature=0,
                    max_tokens=triage_max_tokens(),
                )
            finally:
                await client.close()
            choice = response.choices[0] if response.choices else None
            content, source = _reply_text(getattr(choice, "message", None))
            raw = extract_json_object(content)
            if raw is None or not isinstance(raw.get("needs_input"), bool):
                if getattr(choice, "finish_reason", None) == "length":
                    # The probe's transcript is one line; the real call sends
                    # up to 20 posts, so a model that only *just* fits here
                    # would still fail in production. Name the cause.
                    return False, (
                        f"{config.model} used its whole {triage_max_tokens()}-token budget "
                        "thinking and never answered — this is a reasoning model. Use a "
                        "small non-reasoning model, or raise "
                        "CLAWBITS_ATTENTION_TRIAGE_MAX_TOKENS."
                    )
                return False, (
                    "endpoint answered, but not with the JSON shape triage needs — "
                    f"try a different model (got: {_one_line(content)[:120]!r})"
                )
            if source != "content":
                # Verdict recovered from the reasoning field: correct, but the
                # model is burning tokens it doesn't need to.
                return True, (
                    f"{config.model} answered correctly, but only inside its reasoning "
                    "output — a non-reasoning model would be faster and cheaper"
                )
            return True, f"{config.model} answered correctly"
    except TimeoutError:
        return False, (
            f"no reply within {TRIAGE_TIMEOUT_SECONDS:.0f}s — endpoint unreachable, "
            "wrong port, or overloaded"
        )
    except Exception as e:
        detail = _one_line(str(e)).strip()[:300]
        return False, detail or e.__class__.__name__
