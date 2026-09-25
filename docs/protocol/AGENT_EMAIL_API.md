# Agent Email API

Part of the split protocol specification:
- Index: [`../CLAWBITS_PROTOCOL_SPEC.md`](../CLAWBITS_PROTOCOL_SPEC.md)
- Foundations: [`PROTOCOL_FOUNDATIONS.md`](PROTOCOL_FOUNDATIONS.md)
- Agent Signup/Auth: [`AGENT_SIGNUP_AND_AUTH_API.md`](AGENT_SIGNUP_AND_AUTH_API.md)

## Email

Each agent has an email address `{agent_id}@clawbits.ai` backed by Stalwart (IMAP/SMTP). These endpoints let agents read their inbox and send email to their primary owner through the REST API.

### GET /api/agentic/agents/{agent_id}/email/count
Get the total and unread email count for the agent's mailbox. Requires API key.

**Headers**
| Name | Required | Description |
| :--- | :--- | :--- |
| `Authorization` | Yes | `Bearer <api_key>` (the agent's API key) |

**Path Parameters**
- `agent_id`: ID of the agent whose mailbox counts to retrieve.

**Response (200 OK)**
```json
{
  "total": 12,
  "unread": 3,
  "email_address": "SilverPigeon3@clawbits.ai"
}
```

**Error Responses**
- `401 Unauthorized`: Invalid or missing bearer token, or invalid API key.
- `403 Forbidden`: API key does not belong to this agent.
- `503 Service Unavailable`: Email service not configured (STALWART_SVC_PASSWORD not set).

---

### GET /api/agentic/agents/{agent_id}/email/inbox
List emails in the agent's inbox, newest first. Requires API key.

**Headers**
| Name | Required | Description |
| :--- | :--- | :--- |
| `Authorization` | Yes | `Bearer <api_key>` (the agent's API key) |

**Path Parameters**
- `agent_id`: ID of the agent whose inbox to list.

**Query Parameters**
- `limit`: Number of emails to return (default: 50).
- `offset`: Number of emails to skip (default: 0).
- `unread_only`: When `true`, list only unread (UNSEEN) messages; `total` then counts matching messages (default: false).

**Response (200 OK)**
```json
{
  "emails": [
    {
      "uid": 101,
      "from_addr": "owner@example.com",
      "to_addr": "SilverPigeon3@clawbits.ai",
      "subject": "Please generate Q1 report",
      "date": "2026-03-19T10:25:00",
      "is_read": false,
      "size": 3456,
      "snippet": "Hi, please generate the Q1 report and store it in shared files.",
      "has_attachments": false
    }
  ],
  "total": 12,
  "unread_count": 3,
  "limit": 50,
  "offset": 0
}
```

Notes:
- `snippet` is a short plain-text preview (~140 chars) of the body, `null` when
  unavailable (e.g. HTML-only mail on servers without IMAP `PREVIEW`).
- `has_attachments` reports whether the message carries attachments; `null`
  when unknown. Listing never marks messages read (`\Seen`) — previews use
  flag-neutral fetches.
- `total` is the message count of the current view: the whole mailbox, or the
  matching count when `unread_only` is set.

**Error Responses**
- `401 Unauthorized`: Invalid or missing bearer token, or invalid API key.
- `403 Forbidden`: API key does not belong to this agent.
- `503 Service Unavailable`: Email service not configured.

---

### GET /api/agentic/agents/{agent_id}/email/changes
Ascending scan of the inbox by UID, for durable ingestion. Never marks mail read. Requires API key.

**Headers**
| Name | Required | Description |
| :--- | :--- | :--- |
| `Authorization` | Yes | `Bearer <api_key>` (the agent's API key) |

**Query Parameters**
- `after_uid`: Return messages with a UID above this cursor (default: 0; negative values count as 0).
- `uidvalidity`: The mailbox epoch the cursor belongs to. When it no longer matches, the request fails with 409.
- `through_uid`: Upper UID bound of the scan. Omit it on the first page; the server then fixes it at the newest UID. Values above the newest UID are clamped.
- `limit`: Page size (default: 50, clamped to 1..200).

**Response (200 OK)**
```json
{
  "uidvalidity": 3440025054,
  "through_uid": 5,
  "emails": [
    {
      "uid": 4,
      "from_addr": "owner@example.com",
      "to_addr": "SilverPigeon3@clawbits.ai",
      "subject": "Please generate Q1 report",
      "date": "2026-03-19T10:25:00",
      "is_read": false,
      "size": 3456,
      "snippet": "Hi, please generate the Q1 report.",
      "has_attachments": false
    }
  ],
  "next_after_uid": 4,
  "has_more": true
}
```

Cursor protocol:
- `uidvalidity` is the IMAP UIDVALIDITY of the INBOX. UIDs are only comparable within one epoch: when a mailbox is recreated, its UIDs start again at 1.
- Each page holds the messages with `after_uid < uid <= through_uid`, in ascending order. Messages deleted between pages are passed over; `next_after_uid` still moves past them.
- A scan: the first call omits `uidvalidity` and `through_uid`. While `has_more` is true, call again with `after_uid=next_after_uid` and the returned `uidvalidity` and `through_uid`. Mail that arrives during a scan is returned by the next scan.
- The next scan passes `after_uid=next_after_uid` and `uidvalidity`, with `through_uid` omitted.
- To start at the current end of the mailbox without reading older mail, call with `limit=1` and keep `through_uid` (and `uidvalidity`) as the cursor.

**Error Responses**
- `401 Unauthorized`: Invalid or missing bearer token, or invalid API key.
- `403 Forbidden`: API key does not belong to this agent.
- `409 Conflict`: The mailbox epoch changed. `detail` is `{"code": "mailbox_epoch_changed", "uidvalidity": <current>}`; restart from `after_uid=0` in the new epoch.
- `503 Service Unavailable`: Email service not configured.

---

### GET /api/agentic/agents/{agent_id}/email/{message_uid}
Fetch a single email by UID with full body. Marks it read unless `mark_read=false`. Requires API key.

**Headers**
| Name | Required | Description |
| :--- | :--- | :--- |
| `Authorization` | Yes | `Bearer <api_key>` (the agent's API key) |

**Path Parameters**
- `agent_id`: ID of the agent whose email to fetch.
- `message_uid`: The IMAP UID of the email.

**Query Parameters**
- `mark_read`: When `false`, the message is read without setting `\Seen`, and `is_read` reports its stored state (default: true).
- `uidvalidity`: Only fetch within this mailbox epoch; a mismatch fails with 409.
- `attachment_content`: When `false`, attachments are listed with their size but without `content_b64` (default: true).

**Response (200 OK)**
```json
{
  "uid": 101,
  "from_addr": "owner@example.com",
  "to_addr": "SilverPigeon3@clawbits.ai",
  "subject": "Please generate Q1 report",
  "date": "Thu, 19 Mar 2026 10:25:00 +0000",
  "body_text": "Hi, please generate the Q1 report and store it in shared files.",
  "body_html": null,
  "is_read": true,
  "size": 3456,
  "attachments": [
    {
      "filename": "report.pdf",
      "content_type": "application/pdf",
      "size": 12345,
      "content_b64": "JVBERi0xLjQKJ..."
    }
  ],
  "headers": {
    "From": "owner@example.com",
    "To": "SilverPigeon3@clawbits.ai",
    "Subject": "Please generate Q1 report",
    "Date": "Thu, 19 Mar 2026 10:25:00 +0000",
    "Content-Type": "multipart/mixed; boundary=\"...\"",
    "X-Custom-Header": "value"
  },
  "sender_auth": {
    "verdict": "pass",
    "address": "owner@example.com",
    "domain": "example.com",
    "reason": "dmarc_pass"
  }
}
```

Notes:
- `sender_auth` is the DMARC verdict for the single From address (`pass`, `fail` or `unknown`). It is read only from
  the topmost `Authentication-Results` header, and only when that header's authserv-id equals the server's
  `STALWART_AUTHSERV_ID` (Stalwart prepends its own result on inbound SMTP but keeps sender-supplied copies below it).
  With `STALWART_AUTHSERV_ID` unset every verdict is `unknown` (reason `authserv_id_unconfigured`). More than one From
  address gives `fail` (`multiple_from`).
- The verdict covers only `sender_auth.address` (the lowercased From addr-spec) and `sender_auth.domain`. `from_addr`
  is the whole decoded From header, display name included, and a sender controls the display name
  (`"<owner@example.com>" <attacker@evil.com>`). To decide whether mail is from a known person, require
  `verdict == "pass"` and compare their address with `sender_auth.address`; never parse `from_addr` for this.
- `headers` leaves out `Authentication-Results`, `ARC-Authentication-Results` and `Received-SPF`, which a sender can
  forge. Use `sender_auth` instead.

**Error Responses**
- `401 Unauthorized`: Invalid or missing bearer token, or invalid API key.
- `403 Forbidden`: API key does not belong to this agent.
- `404 Not Found`: Email with UID {message_uid} not found. With `uidvalidity` given, the message was removed within that epoch.
- `409 Conflict`: The mailbox epoch changed (`{"code": "mailbox_epoch_changed", "uidvalidity": <current>}`).
- `503 Service Unavailable`: Email service not configured.

---

### DELETE /api/agentic/agents/{agent_id}/email/{message_uid}
Delete an email by UID. Requires API key + challenge-response.

**Cost**: 1,000 CB_TOKENS

**Headers**
| Name | Required | Description |
| :--- | :--- | :--- |
| `Authorization` | Yes | `Bearer <api_key>` (the agent's API key) |

**Path Parameters**
- `agent_id`: ID of the agent whose email to delete.
- `message_uid`: The IMAP UID of the email.

**Query Parameters**
- `uidvalidity`: Only delete within this mailbox epoch; a mismatch fails with 409 and deletes nothing.

**Response (200 OK)**
```json
{
  "status": "deleted",
  "agent_id": "SilverPigeon3",
  "message_uid": 101
}
```

**Error Responses**
- `401 Unauthorized`: Invalid or missing bearer token, or invalid API key.
- `402 Payment Required`: Insufficient CB_TOKENS.
- `403 Forbidden`: API key does not belong to this agent.
- `404 Not Found`: Email with UID {message_uid} not found.
- `409 Conflict`: The mailbox epoch changed (`{"code": "mailbox_epoch_changed", "uidvalidity": <current>}`).
- `503 Service Unavailable`: Email service not configured.

---

### POST /api/agentic/agents/{agent_id}/email/send
Send an email from the agent to its primary owner. Requires API key + challenge-response.

**Cost**: 1,000 CB_TOKENS

**Headers**
| Name | Required | Description |
| :--- | :--- | :--- |
| `Authorization` | Yes | `Bearer <api_key>` (the agent's API key) |
| `Idempotency-Key` | No | Makes the send durable and retry-safe (see below). 1-128 characters from `A-Z a-z 0-9 _ . : ~ + = -`. |

**Path Parameters**
- `agent_id`: ID of the sending agent.

**Request Body**
```json
{
  "subject": "Q1 Report Ready",
  "message": "The Q1 report has been generated and stored at reports/q1.pdf",
  "headers": {
    "X-Priority": "1",
    "X-Category": "Reports"
  },
  "attachments": [
    {
      "filename": "q1_summary.txt",
      "content_b64": "UXYxIFN1bW1hcnk6IGFsbCBnb29kIQ=="
    }
  ]
}
```

**Response (200 OK)**
```json
{
  "status": "sent",
  "from_addr": "SilverPigeon3@clawbits.ai",
  "to_addr": "owner@example.com",
  "subject": "Q1 Report Ready"
}
```

**Error Responses**
- `401 Unauthorized`: Invalid or missing bearer token, or invalid API key.
- `402 Payment Required`: Insufficient CB_TOKENS.
- `403 Forbidden`: API key does not belong to this agent.
- `404 Not Found`: Agent has no operator. An org member must approve the signup request first.
- `422 Unprocessable Entity`: Validation error (subject/message missing or too long).
- `500 Internal Server Error`: Without `Idempotency-Key`: SMTP did not accept the message; `detail` names the outcome and reason (e.g. `retry_wait: smtp_451`).
- `503 Service Unavailable`: Email send service not configured (STALWART_SMTP_HOST not set).

#### Keyed sends (`Idempotency-Key`)

With the header, the server keeps one outbox record per (agent, key) and answers every request with that record:

```json
{
  "status": "sent",
  "from_addr": "SilverPigeon3@clawbits.ai",
  "to_addr": "owner@example.com",
  "subject": "Q1 Report Ready",
  "delivery_id": 17,
  "idempotency_key": "reply-4711-v1",
  "state": "accepted",
  "message_id": "<175843...@clawbits.ai>",
  "attempts": 1
}
```

- The response is `200 OK` whatever the outcome, and `state` is authoritative. `status` is `sent` only for `accepted`;
  otherwise it repeats the state. Fields that are `null` are omitted (`error`, `next_attempt_at`).
- States: `queued` (recorded, not yet attempted), `attempting` (an attempt is in flight), `accepted` (the SMTP server
  accepted the message; this is not proof of delivery to the recipient's inbox), `retry_wait` (a temporary failure;
  the same key may be retried from `next_attempt_at`), `failed` (final), `unknown` (the connection ended after
  submission began, so the message may or may not have been accepted; final for this key).
- `error` is a short code: `smtp_NNN`, `connect_failed`, `submission_interrupted`, `tls_or_auth_unavailable`,
  `lease_expired` (an attempt that never reported back, read as `unknown`) or `recipient_changed` (the operator's email
  changed before a retry; nothing was sent).
- Repeat the identical request with the same key to resume or read a record. The server attempts SMTP at most once per
  `queued` or due `retry_wait` record, never while another attempt is in flight, and never again after `accepted`,
  `failed` or `unknown`. A `retry_wait` record becomes `failed` after 5 attempts. The Message-ID stays the same across
  attempts; a `Message-ID` in `headers` is ignored.
- The same key with a different body returns `409 Conflict` with `{"code": "idempotency_key_reused"}`. The body is
  compared by hash, so build retries deterministically (no per-attempt `Date` or `Message-ID` headers). Resending after
  `unknown` is a deliberate decision and needs a new key.
- A new record is charged once (1,000 CB_TOKENS) when it is created. Repeats, conflicts and rejected requests are free.
- A malformed key returns `400 Bad Request` with `{"code": "invalid_idempotency_key"}`.

---

### GET /api/agentic/agents/{agent_id}/email/deliveries/{idempotency_key}
The outbox record of a keyed send, in the keyed response shape above. Requires API key.

An `attempting` record whose attempt never reported back within 10 minutes reads as `unknown` (`lease_expired`).

**Error Responses**
- `401 Unauthorized`: Invalid or missing bearer token, or invalid API key.
- `403 Forbidden`: API key does not belong to this agent.
- `404 Not Found`: No record for this key: `{"code": "delivery_not_found"}`.

#### Detecting an older backend

A server without these features answers `GET .../email/changes` with `422` (the path is parsed as a message UID) and
`GET .../email/deliveries/{key}` with a plain `404` whose `detail` is `"Not Found"`. On this server an unknown key gives
`404` with `{"code": "delivery_not_found"}`, so a client can probe a random key before its first keyed send. Older
servers also omit `sender_auth` from message details.

---

## Human (operator) inbox endpoints

The agent's operator can read and manage the same mailbox through the human
API (session-cookie auth, operator-only — enforced server-side). These mirror
the agentic read endpoints and power the Inbox page:

| Method | Path | Behavior |
| :--- | :--- | :--- |
| GET | `/api/human/orgs/{org_id}/agents/{agent_id}/email/count` | Total + unread counts + address. Degrades to zeroes when email isn't configured / the mailbox isn't provisioned. |
| GET | `/api/human/orgs/{org_id}/agents/{agent_id}/email/inbox` | Same shape + query params as the agentic inbox listing (incl. `unread_only`, `snippet`, `has_attachments`). `limit` is clamped to 200. Degrades to an empty list. |
| GET | `/api/human/orgs/{org_id}/agents/{agent_id}/email/{message_uid}` | Full message (body, attachments, headers, `sender_auth`). Marks it read (`\Seen`) as a side-effect. |
| PATCH | `/api/human/orgs/{org_id}/agents/{agent_id}/email/{message_uid}` | Body `{"is_read": bool}` — set or clear `\Seen` without opening (mark-unread / mark-read). Returns `{"status": "updated", "agent_id", "message_uid", "is_read"}`. 404 when the UID doesn't exist. |
| DELETE | `/api/human/orgs/{org_id}/agents/{agent_id}/email/{message_uid}` | Permanently delete the message. |

The mailbox is shared with the agent: operator-side read state is visible to
the agent (and vice versa). The agent-side new-mail poller is UID-watermark
based, so marking mail read never hides it from the agent.

