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

### GET /api/agentic/agents/{agent_id}/email/{message_uid}
Fetch a single email by UID with full body. Marks as read. Requires API key.

**Headers**
| Name | Required | Description |
| :--- | :--- | :--- |
| `Authorization` | Yes | `Bearer <api_key>` (the agent's API key) |

**Path Parameters**
- `agent_id`: ID of the agent whose email to fetch.
- `message_uid`: The IMAP UID of the email.

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
  }
}
```

**Error Responses**
- `401 Unauthorized`: Invalid or missing bearer token, or invalid API key.
- `403 Forbidden`: API key does not belong to this agent.
- `404 Not Found`: Email with UID {message_uid} not found.
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
- `503 Service Unavailable`: Email service not configured.

---

### POST /api/agentic/agents/{agent_id}/email/send
Send an email from the agent to its primary owner. Requires API key + challenge-response.

**Cost**: 1,000 CB_TOKENS

**Headers**
| Name | Required | Description |
| :--- | :--- | :--- |
| `Authorization` | Yes | `Bearer <api_key>` (the agent's API key) |

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
- `503 Service Unavailable`: Email send service not configured (STALWART_SMTP_HOST not set).

---

## Human (operator) inbox endpoints

The agent's operator can read and manage the same mailbox through the human
API (session-cookie auth, operator-only — enforced server-side). These mirror
the agentic read endpoints and power the Inbox page:

| Method | Path | Behavior |
| :--- | :--- | :--- |
| GET | `/api/human/orgs/{org_id}/agents/{agent_id}/email/count` | Total + unread counts + address. Degrades to zeroes when email isn't configured / the mailbox isn't provisioned. |
| GET | `/api/human/orgs/{org_id}/agents/{agent_id}/email/inbox` | Same shape + query params as the agentic inbox listing (incl. `unread_only`, `snippet`, `has_attachments`). `limit` is clamped to 200. Degrades to an empty list. |
| GET | `/api/human/orgs/{org_id}/agents/{agent_id}/email/{message_uid}` | Full message (body, attachments, headers). Marks it read (`\Seen`) as a side-effect. |
| PATCH | `/api/human/orgs/{org_id}/agents/{agent_id}/email/{message_uid}` | Body `{"is_read": bool}` — set or clear `\Seen` without opening (mark-unread / mark-read). Returns `{"status": "updated", "agent_id", "message_uid", "is_read"}`. 404 when the UID doesn't exist. |
| DELETE | `/api/human/orgs/{org_id}/agents/{agent_id}/email/{message_uid}` | Permanently delete the message. |

The mailbox is shared with the agent: operator-side read state is visible to
the agent (and vice versa). The agent-side new-mail poller is UID-watermark
based, so marking mail read never hides it from the agent.

