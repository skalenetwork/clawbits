"""Publish Stalwart's auto-generated DNS zone to Cloudflare.

Stalwart generates the exact DNS records a domain needs for deliverable email
(DKIM, SPF, MX, DMARC, MTA-STS, TLS-RPT, client autoconfig). We read that zone
via :func:`clawbits.email.stalwart_provision.domain_dns_zone`, parse it, and
idempotently create-or-update each record in the matching Cloudflare zone using
the API token clawbits already holds.

Safe by default: :func:`sync_domain` only prints the plan unless ``apply=True``.
Run it once per env at deploy/bootstrap (DNS rarely changes thereafter).

    python -m clawbits.email.cloudflare_dns --domain mail.clawbits.ai            # dry-run
    python -m clawbits.email.cloudflare_dns --domain mail.clawbits.ai --apply    # write

Env: CLOUDFLARE_API_TOKEN (Zone:DNS:Edit). The public mail host (the target of
MX/CNAME/SRV records) defaults to the domain itself; override with --mail-host
when Stalwart's reported server hostname differs.
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"
# Record types we publish. SRV/autoconfig are client-convenience; the rest are
# delivery-critical. A/AAAA are host-specific and managed out of band.
_PUSH_TYPES = {"TXT", "MX", "CNAME", "SRV"}


@dataclass
class Record:
    name: str          # FQDN, no trailing dot
    rtype: str
    content: str       # target/value (TXT: unquoted joined string)
    priority: int | None = None   # MX
    data: dict | None = None      # SRV structured data

    def key(self) -> tuple[str, str, str]:
        return (self.name.lower(), self.rtype, self.content)


# ---------------------------------------------------------------------------
# Zone parsing
# ---------------------------------------------------------------------------

def parse_zone(zone_text: str, *, mail_host: str | None = None) -> list[Record]:
    """Parse Stalwart's BIND-style zone into Cloudflare-ready records.

    Handles multi-line parenthesised TXT (e.g. RSA DKIM) and concatenated
    quoted strings. If *mail_host* is given, MX/CNAME/SRV targets are rewritten
    to it (Stalwart emits its own server hostname, which in prod must be the
    public mail host).
    """
    # 1) Join parenthesised multi-line records onto a single logical line.
    logical: list[str] = []
    buf = ""
    depth = 0
    for raw in zone_text.splitlines():
        line = raw.strip()
        if not line or line.startswith(";"):
            continue
        depth += line.count("(") - line.count(")")
        buf = f"{buf} {line}" if buf else line
        if depth <= 0:
            logical.append(buf)
            buf = ""
            depth = 0
    if buf:
        logical.append(buf)

    records: list[Record] = []
    for line in logical:
        line = line.replace("(", " ").replace(")", " ").strip()
        m = re.match(r"^(\S+)\s+IN\s+(\w+)\s+(.*)$", line)
        if not m:
            continue
        name, rtype, rest = m.group(1).rstrip("."), m.group(2).upper(), m.group(3).strip()
        if rtype not in _PUSH_TYPES:
            continue

        if rtype == "TXT":
            chunks = re.findall(r'"([^"]*)"', rest)
            content = "".join(chunks) if chunks else rest.strip('"')
            records.append(Record(name, "TXT", content))
        elif rtype == "MX":
            parts = rest.split()
            prio = int(parts[0]) if parts and parts[0].isdigit() else 10
            target = (mail_host or parts[-1].rstrip(".")) if len(parts) >= 2 else (mail_host or "")
            records.append(Record(name, "MX", target, priority=prio))
        elif rtype == "CNAME":
            target = mail_host or rest.split()[0].rstrip(".")
            records.append(Record(name, "CNAME", target))
        elif rtype == "SRV":
            parts = rest.split()
            if len(parts) >= 4:
                prio, weight, port = int(parts[0]), int(parts[1]), int(parts[2])
                target = mail_host or parts[3].rstrip(".")
                svc, _, proto_name = name.partition(".")
                proto = proto_name.split(".", 1)[0]
                records.append(Record(
                    name, "SRV", f"{prio} {weight} {port} {target}",
                    data={"priority": prio, "weight": weight, "port": port,
                          "target": target, "service": svc, "proto": proto,
                          "name": name},
                ))
    return records


# ---------------------------------------------------------------------------
# Cloudflare API
# ---------------------------------------------------------------------------

def _zone_name_for(domain: str) -> str:
    """Registrable zone for a (sub)domain: mail.clawbits.ai -> clawbits.ai."""
    labels = domain.rstrip(".").split(".")
    return ".".join(labels[-2:]) if len(labels) >= 2 else domain


def _cf(token: str) -> httpx.Client:
    return httpx.Client(
        base_url=CLOUDFLARE_API,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=15.0,
    )


def _zone_id(client: httpx.Client, zone_name: str) -> str:
    r = client.get("/zones", params={"name": zone_name})
    r.raise_for_status()
    result = r.json().get("result") or []
    if not result:
        raise RuntimeError(f"Cloudflare zone not found: {zone_name}")
    return result[0]["id"]


def _record_payload(rec: Record) -> dict:
    body: dict = {"type": rec.rtype, "name": rec.name, "ttl": 1}
    if rec.rtype == "MX":
        body.update(content=rec.content, priority=rec.priority or 10)
    elif rec.rtype == "SRV":
        body["data"] = rec.data
    else:
        body["content"] = rec.content
    return body


def sync_domain(domain: str, *, apply: bool = False, mail_host: str | None = None,
                token: str | None = None) -> dict:
    """Sync Stalwart's generated zone for *domain* into Cloudflare. Idempotent.

    Returns a summary ``{"create": [...], "update": [...], "noop": [...]}``.
    With ``apply=False`` (default) nothing is written - the plan is returned/printed.
    """
    from clawbits.email.stalwart_provision import domain_dns_zone

    token = token or os.getenv("CLOUDFLARE_API_TOKEN") or ""
    if not token:
        raise RuntimeError("CLOUDFLARE_API_TOKEN not set")
    zone_text = domain_dns_zone(domain)
    if not zone_text:
        raise RuntimeError(f"Stalwart returned no DNS zone for {domain}")

    desired = parse_zone(zone_text, mail_host=mail_host or domain)
    zone_name = _zone_name_for(domain)
    plan: dict[str, list] = {"create": [], "update": [], "noop": []}

    with _cf(token) as client:
        zid = _zone_id(client, zone_name)
        # Existing records, indexed by (name, type).
        existing: dict[tuple[str, str], list[dict]] = {}
        page = 1
        while True:
            r = client.get(f"/zones/{zid}/dns_records", params={"per_page": 100, "page": page})
            r.raise_for_status()
            rows = r.json().get("result") or []
            for row in rows:
                existing.setdefault((row["name"].lower(), row["type"]), []).append(row)
            if len(rows) < 100:
                break
            page += 1

        for rec in desired:
            matches = existing.get((rec.name.lower(), rec.rtype), [])
            payload = _record_payload(rec)
            same = next((m for m in matches if _content_matches(m, rec)), None)
            if same:
                plan["noop"].append(rec)
                continue
            if matches:  # update the first existing record of this name/type
                plan["update"].append(rec)
                if apply:
                    rr = client.put(f"/zones/{zid}/dns_records/{matches[0]['id']}", json=payload)
                    rr.raise_for_status()
            else:
                plan["create"].append(rec)
                if apply:
                    rr = client.post(f"/zones/{zid}/dns_records", json=payload)
                    rr.raise_for_status()
    return plan


def _content_matches(cf_row: dict, rec: Record) -> bool:
    if rec.rtype == "MX":
        return cf_row.get("content", "").rstrip(".") == rec.content and \
            int(cf_row.get("priority", -1)) == (rec.priority or 10)
    if rec.rtype == "CNAME":
        return cf_row.get("content", "").rstrip(".") == rec.content
    if rec.rtype == "SRV":
        d = cf_row.get("data") or {}
        return (d.get("target", "").rstrip("."), d.get("port"), d.get("priority"), d.get("weight")) == \
            (rec.data["target"], rec.data["port"], rec.data["priority"], rec.data["weight"])
    return cf_row.get("content", "") == rec.content  # TXT


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser(description="Sync Stalwart's DNS zone to Cloudflare")
    ap.add_argument("--domain", required=True, help="mail domain, e.g. mail.clawbits.ai")
    ap.add_argument("--mail-host", default=None, help="public mail host for MX/CNAME/SRV targets (default: --domain)")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    args = ap.parse_args(argv)
    plan = sync_domain(args.domain, apply=args.apply, mail_host=args.mail_host)
    verb = "APPLIED" if args.apply else "DRY-RUN (no changes written)"
    print(f"\nCloudflare DNS sync for {args.domain} - {verb}")
    for action in ("create", "update", "noop"):
        for rec in plan[action]:
            extra = f" prio={rec.priority}" if rec.priority is not None else ""
            print(f"  {action.upper():6} {rec.rtype:5} {rec.name} -> {rec.content[:70]}{extra}")
    print(f"\n  create={len(plan['create'])} update={len(plan['update'])} noop={len(plan['noop'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
