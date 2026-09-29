"""Sender-authentication verdict from the receiving Stalwart's own Authentication-Results.

Stalwart prepends its Authentication-Results on inbound SMTP and keeps any sender-supplied
copies below it, even ones claiming its own authserv-id. So only the topmost header is ours,
and only when its authserv-id matches the configured one (RFC 8601 section 7.1).
"""
from __future__ import annotations

import re
from email.message import Message
from email.utils import getaddresses
from typing import Literal, TypedDict

Verdict = Literal["pass", "fail", "unknown"]
UNTRUSTED_AUTH_HEADERS = frozenset({"authentication-results", "arc-authentication-results", "received-spf"})
_COMMENT = re.compile(r"\([^()]*\)")
# A pvalue may be a quoted-string, so ';' and '(' inside one are data, not structure.
_QUOTED = re.compile(r'"(?:[^"\\]|\\.)*"')


class SenderAuthResult(TypedDict):
    verdict: Verdict
    address: str | None
    domain: str | None
    reason: str


def _strip_comments(value: str) -> str:
    while (stripped := _COMMENT.sub(" ", value)) != value:
        value = stripped
    return value


def _props(resinfo: str) -> dict[str, str]:
    tokens = (t.lower().partition("=") for t in resinfo.split() if "=" in t)
    return {k: v.strip('"') for k, _, v in tokens}


def _result(verdict: Verdict, address: str | None, reason: str) -> SenderAuthResult:
    domain = address.rpartition("@")[2].rstrip(".") if address else None
    return {"verdict": verdict, "address": address, "domain": domain, "reason": reason}


def sender_auth_verdict(msg: Message, authserv_id: str | None) -> SenderAuthResult:
    """DMARC verdict for the single From addr-spec, read only from our MTA's topmost Authentication-Results.

    The verdict covers only ``address`` (lowercased) and its ``domain``, never the From display name.
    """
    froms = msg.get_all("From") or []
    addresses = [addr for _, addr in getaddresses([str(v) for v in froms]) if addr]
    if len(froms) > 1 or len(addresses) > 1:
        return _result("fail", None, "multiple_from")
    address = addresses[0].strip().lower() if addresses else ""
    domain = address.rpartition("@")[2].rstrip(".") if "@" in address else ""
    if not domain:
        return _result("unknown", None, "no_from_domain")
    if not authserv_id:
        return _result("unknown", address, "authserv_id_unconfigured")
    results = msg.get_all("Authentication-Results") or []
    parts = _strip_comments(_QUOTED.sub('""', str(results[0]))).split(";") if results else [""]
    if (parts[0].split() or [""])[0].lower() != authserv_id.lower():
        return _result("unknown", address, "no_trusted_result")
    # Our MTA states its DMARC result exactly once; a second one means the header was tampered with.
    dmarc = [props for part in parts[1:] if "dmarc" in (props := _props(part))]
    if len(dmarc) > 1:
        return _result("unknown", address, "ambiguous_dmarc_result")
    if not dmarc:
        return _result("unknown", address, "no_dmarc_result")
    if dmarc[0].get("header.from", "").rstrip(".") != domain:
        return _result("unknown", address, "dmarc_domain_mismatch")
    result = dmarc[0]["dmarc"]
    return _result(result if result in ("pass", "fail") else "unknown", address, f"dmarc_{result}")
