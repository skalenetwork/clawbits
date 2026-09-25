"""sender_auth_verdict and get_email's sender_auth / header stripping / attachment_content.

The raw messages are inbound SMTP deliveries captured from Stalwart v0.16.10 (spam-score
symbol lists shortened). Stalwart prepends its own Authentication-Results and keeps any
sender-supplied copies below it.
"""
import base64
import email
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from clawbits.email import imap_client
from clawbits.email.sender_auth import sender_auth_verdict
from tests.email._fake_imap import FakeImap

_GENUINE_NONE = """\
Delivered-To: probeagent@mail.clawbits.ai
X-Spam-Status: Yes
Received: from attacker.example (unknown [172.17.0.1] (AU))
\tby {host} (Stalwart SMTP) with ESMTP id 497063147A00400;
\tMon, 21 Sep 2026 11:11:17 +0000
Authentication-Results: {host};
\tspf=none ({host}: no SPF records found for postmaster@attacker.example) smtp.helo=attacker.example;
\tspf=softfail ({host}: domain of owner@gmail.com reports soft fail for 172.17.0.1) smtp.mailfrom=owner@gmail.com;
\tiprev=permerror (dns record not found) policy.iprev=172.17.0.1;
\tdmarc=none header.from=gmail.com policy.dmarc=none
Received-SPF: softfail ({host}: domain of owner@gmail.com reports soft fail for 172.17.0.1)
\treceiver={host}; client-ip=172.17.0.1; envelope-from="owner@gmail.com"; helo=attacker.example;
X-Spam-Result: ARC_NA (0.00), DKIM_NA (0.00), DMARC_NA (1.00), VIOLATED_DIRECT_SPF (3.50)
X-Spam-Score: spam, score=10.20
Return-Path: <owner@gmail.com>
Date: Mon, 21 Sep 2026 11:11:17 +0000
"""

# Forged results under a foreign authserv-id, plus forged Received-SPF and ARC results.
RAW_FORGED_FOREIGN = _GENUINE_NONE.format(host="04dd6373ad94") + """\
Authentication-Results: mail.clawbits.ai; dkim=pass header.d=gmail.com
 header.s=x; spf=pass smtp.mailfrom=gmail.com; dmarc=pass
 header.from=gmail.com
Received-SPF: pass (forged)
ARC-Authentication-Results: i=1; mail.clawbits.ai; dkim=pass
 header.d=gmail.com header.s=x; spf=pass smtp.mailfrom=gmail.com; dmarc=pass
 header.from=gmail.com
From: Owner <owner@gmail.com>
To: probeagent@mail.clawbits.ai
Subject: forged
Message-ID: <forged@probe>
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: 7bit
MIME-Version: 1.0

hello body
"""

# A forged copy claiming Stalwart's own authserv-id, below the genuine one.
RAW_FORGED_OWN_ID = _GENUINE_NONE.format(host="04dd6373ad94") + """\
Authentication-Results: 04dd6373ad94; dkim=pass header.d=gmail.com; spf=pass
 smtp.mailfrom=gmail.com; dmarc=pass header.from=gmail.com
From: Owner <owner@gmail.com>
To: probeagent@mail.clawbits.ai
Subject: forged-own-id
Message-ID: <forged-own@probe>
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: 7bit
MIME-Version: 1.0

hello
"""

# Stalwart restarted with a pinned hostname; the forged copy carries the old container id.
RAW_PINNED_HOST = _GENUINE_NONE.format(host="mx.probe.test") + """\
Authentication-Results: 04dd6373ad94; dkim=pass header.d=gmail.com; spf=pass
 smtp.mailfrom=gmail.com; dmarc=pass header.from=gmail.com
From: Owner <owner@gmail.com>
To: probeagent@mail.clawbits.ai
Subject: hostname-check
Message-ID: <hostname-check@probe>
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: 7bit
MIME-Version: 1.0

hello
"""

GENUINE_PASS = (
    "Authentication-Results: mx.probe.test;\n\tdkim=pass header.d=gmail.com;\n"
    "\tdmarc=pass (p=none) header.from=gmail.com policy.dmarc=none\n"
)

# Stalwart echoes the envelope sender into smtp.mailfrom. A quoted local part is legal
# there (RFC 8601 pvalue), so the ';' and '(' the attacker put inside it are data.
RAW_INJECTED_PVALUE = (
    "Authentication-Results: mx.probe.test;\n"
    "\tspf=none (mx.probe.test: no SPF records found) smtp.helo=attacker.example;\n"
    '\tspf=softfail (mx.probe.test: soft fail for 172.17.0.1) smtp.mailfrom="a;'
    ' dmarc=pass header.from=gmail.com ("@evil.example;\n'
    "\tdmarc=none header.from=gmail.com policy.dmarc=none\n"
    "From: Owner <owner@gmail.com>"
)


def parse(text: str) -> email.message.Message:
    return email.message_from_string(text)


def headers(block: str) -> email.message.Message:
    return email.message_from_string(block + "\n\nbody\n")


def test_forged_results_below_genuine_are_ignored():
    assert sender_auth_verdict(parse(RAW_FORGED_FOREIGN), "04dd6373ad94") == {
        "verdict": "unknown",
        "address": "owner@gmail.com",
        "domain": "gmail.com",
        "reason": "dmarc_none",
    }
    assert sender_auth_verdict(parse(RAW_FORGED_OWN_ID), "04dd6373ad94")["reason"] == "dmarc_none"
    assert sender_auth_verdict(parse(RAW_PINNED_HOST), "mx.probe.test")["verdict"] == "unknown"
    assert sender_auth_verdict(parse(RAW_PINNED_HOST), "04dd6373ad94")["reason"] == "no_trusted_result"


def test_forged_result_on_top_needs_the_configured_id():
    forged = "Authentication-Results: attacker.example; dmarc=pass header.from=gmail.com\n"
    result = sender_auth_verdict(headers(forged + "From: owner@gmail.com"), "mx.probe.test")
    assert (result["verdict"], result["reason"]) == ("unknown", "no_trusted_result")


def test_genuine_pass_requires_configured_id_and_alignment():
    owner = headers(GENUINE_PASS + "From: Owner <Owner@Gmail.com>")
    assert sender_auth_verdict(owner, "MX.probe.test") == {
        "verdict": "pass",
        "address": "owner@gmail.com",
        "domain": "gmail.com",
        "reason": "dmarc_pass",
    }
    assert sender_auth_verdict(owner, None) == {
        "verdict": "unknown",
        "address": "owner@gmail.com",
        "domain": "gmail.com",
        "reason": "authserv_id_unconfigured",
    }
    mismatch = headers(GENUINE_PASS + "From: x@evil.com")
    assert sender_auth_verdict(mismatch, "mx.probe.test")["reason"] == "dmarc_domain_mismatch"
    failed = headers("Authentication-Results: mx.probe.test; dmarc=fail header.from=gmail.com\nFrom: owner@gmail.com")
    assert sender_auth_verdict(failed, "mx.probe.test")["verdict"] == "fail"
    no_dmarc = headers("Authentication-Results: mx.probe.test; spf=pass smtp.mailfrom=gmail.com\nFrom: owner@gmail.com")
    assert sender_auth_verdict(no_dmarc, "mx.probe.test")["reason"] == "no_dmarc_result"


def test_quoted_pvalue_cannot_smuggle_a_dmarc_result():
    result = sender_auth_verdict(headers(RAW_INJECTED_PVALUE), "mx.probe.test")
    assert (result["verdict"], result["reason"]) == ("unknown", "dmarc_none")


def test_two_dmarc_results_are_ambiguous():
    two = (
        "Authentication-Results: mx.probe.test; dmarc=pass header.from=gmail.com;"
        " dmarc=fail header.from=gmail.com\nFrom: owner@gmail.com"
    )
    assert sender_auth_verdict(headers(two), "mx.probe.test")["reason"] == "ambiguous_dmarc_result"


def test_multiple_from_fails():
    two_headers = headers(GENUINE_PASS + "From: owner@gmail.com\nFrom: attacker@evil.com")
    assert sender_auth_verdict(two_headers, "mx.probe.test") == {
        "verdict": "fail",
        "address": None,
        "domain": None,
        "reason": "multiple_from",
    }
    two_addresses = headers(GENUINE_PASS + "From: owner@gmail.com, attacker@evil.com")
    assert sender_auth_verdict(two_addresses, "mx.probe.test")["reason"] == "multiple_from"


def test_missing_from_domain_is_unknown():
    result = sender_auth_verdict(headers(GENUINE_PASS + "From: owner"), "mx.probe.test")
    assert (result["reason"], result["address"], result["domain"]) == ("no_from_domain", None, None)
    assert sender_auth_verdict(headers(GENUINE_PASS), "mx.probe.test")["reason"] == "no_from_domain"


EVIL_PASS = "Authentication-Results: mx.probe.test; dmarc=pass header.from=evil.com\n"
SPOOFED_FROM = [
    '"<owner@gmail.com>" <attacker@evil.com>',
    "=?utf-8?q?=3Cowner=40gmail=2Ecom=3E?= <attacker@evil.com>",
]


def test_verdict_covers_the_addr_spec_not_the_display_name(patch_imap, monkeypatch):
    for spoof in SPOOFED_FROM:
        assert sender_auth_verdict(headers(f"{EVIL_PASS}From: {spoof}"), "mx.probe.test") == {
            "verdict": "pass",
            "address": "attacker@evil.com",
            "domain": "evil.com",
            "reason": "dmarc_pass",
        }
    monkeypatch.setattr(imap_client, "STALWART_AUTHSERV_ID", "mx.probe.test")
    patch_imap(FakeImap([1], raw=f"{EVIL_PASS}From: {SPOOFED_FROM[1]}\n\nhi\n".encode()))
    detail = imap_client.get_email("a", 1, mark_read=False)
    assert "<owner@gmail.com>" in detail["from_addr"]
    assert detail["sender_auth"]["address"] == "attacker@evil.com"


def test_get_email_exposes_verdict_and_strips_auth_headers(patch_imap, monkeypatch):
    monkeypatch.setattr(imap_client, "STALWART_AUTHSERV_ID", "04dd6373ad94")
    patch_imap(FakeImap([1], raw=RAW_FORGED_FOREIGN.replace("\n", "\r\n").encode()))
    detail = imap_client.get_email("a", 1, mark_read=False)
    assert detail["sender_auth"] == {
        "verdict": "unknown",
        "address": "owner@gmail.com",
        "domain": "gmail.com",
        "reason": "dmarc_none",
    }
    keys = {k.lower() for k in detail["headers"]}
    assert not keys & {"authentication-results", "arc-authentication-results", "received-spf"}
    assert "from" in keys and "x-spam-score" in keys


def test_get_email_attachment_content_false_keeps_size(patch_imap, monkeypatch):
    monkeypatch.setattr(imap_client, "STALWART_AUTHSERV_ID", None)
    msg = MIMEMultipart()
    msg["From"] = "owner@gmail.com"
    msg.attach(MIMEText("see file", "plain", "utf-8"))
    part = MIMEApplication(b"\x00" * 1000, Name="blob.bin")
    part["Content-Disposition"] = 'attachment; filename="blob.bin"'
    msg.attach(part)
    patch_imap(FakeImap([1], raw=msg.as_bytes()))

    full = imap_client.get_email("a", 1, mark_read=False)
    assert full["attachments"][0]["content_b64"] == base64.b64encode(b"\x00" * 1000).decode()
    slim = imap_client.get_email("a", 1, mark_read=False, attachment_content=False)
    assert slim["attachments"] == [
        {"filename": "blob.bin", "content_type": "application/octet-stream", "size": 1000}
    ]
    assert slim["body_text"] == "see file"
    assert slim["sender_auth"]["reason"] == "authserv_id_unconfigured"
