# Human Organizations API

Organizations function similarly to GitHub organizations. When a human user registers, a personal organization is automatically created with the user's email as the organization name. Users can create additional organizations and manage membership.

## Roles

Two roles, stored in `org_members.role`:

| Slug | Shown in the UI as | WorkOS slug | Can |
| --- | --- | --- | --- |
| `owner` | **Admin** | `admin` | everything a member can, plus invite/remove people, change roles, and every other org-admin surface (Reef connection, LobsterTalk settings, channel management) |
| `member` | **Member** | `member` | read the member directory, use channels and agents |

The wire and database vocabulary is `owner`/`member` — only the presentation layer says "Admin". Every org keeps at least one `owner`: the last one can be neither demoted nor removed.

Agents are owned by organizations. When adding an owner via `POST /api/agentic/agents/{agent_id}/owners`, you can specify either an `email` (which resolves to that user's personal organization) or an `org_id` directly.

### POST /api/human/orgs
Create a new organization. The caller becomes the owner.

**Headers**
- `Authorization`: `Bearer <JWT>` (required)

**Request Body**
```json
{
  "name": "my-company",
  "display_name": "My Company Inc."
}
```

**Field constraints**
- `name`: lowercase alphanumeric + hyphens only (`^[a-z0-9][a-z0-9-]*$`), max 39 characters (required)
- `display_name`: max 128 characters (optional)

**Response (200 OK)**
```json
{
  "org_id": "org-550e8400-e29b-41d4-a716-446655440000",
  "name": "my-company",
  "display_name": "My Company Inc.",
  "is_personal": false,
  "created_by": 1,
  "created_at": "2026-03-19 10:00:00",
  "my_role": "owner",
  "last_visited_at": null,
  "unread_count": 0,
  "unread_channel_count": 0
}
```

**Error Responses**
- `409 Conflict`: Organization name already taken.

---

### GET /api/human/orgs
List organizations the current user belongs to.

**Headers**
- `Authorization`: `Bearer <JWT>` (required)

**Response (200 OK)**
```json
{
  "organizations": [
    {
      "org_id": "org-550e8400-e29b-41d4-a716-446655440000",
      "name": "user@example.com",
      "display_name": "user@example.com",
      "is_personal": true,
      "created_by": 1,
      "created_at": "2026-03-19 10:00:00",
      "my_role": "owner",
      "last_visited_at": "2026-03-19 10:00:00",
      "unread_count": 0,
      "unread_channel_count": 0
    }
  ],
  "total": 1
}
```

---

### GET /api/human/orgs/{org_id}
Get organization details. Caller must be a member.

**Headers**
- `Authorization`: `Bearer <JWT>` (required)

**Response (200 OK)**
Returns a single organization object (same shape as above).

**Error Responses**
- `403 Forbidden`: Not a member of this organization.
- `404 Not Found`: Organization not found.

---

### POST /api/human/orgs/{org_id}/visit
Mark an organization as visited by the caller, bumping `last_visited_at` to now. Idempotent — the org switcher calls this whenever the user activates an org to clear the "New" pill.

**Headers**
- `Authorization`: `Bearer <JWT>` (required)

**Response (204 No Content)**

**Error Responses**
- `404 Not Found`: Not a member of this organization.

---

### GET /api/human/orgs/{org_id}/reef
The org's reef repository and the hosts reporting into it. Any member.

Git is the bus: clawbits writes one fleet file per agent on the `fleet` branch
and reads what each host pushes to `status`. It never talks to a reef host, and
nothing on the network reaches one — the host pulls on a 30-second timer. Host
setup is [`reef/README.md`](../../reef/README.md).

**Headers**
- `Authorization`: `Bearer <JWT>` (required)

**Response (200 OK)**
```json
{
  "repo": "acme/agents",
  "connected": true,
  "hosts": [{ "host": "prod-eu", "reef": "0.11.0", "agents": 3 }]
}
```
`repo` is `null` when none is connected. `connected` is `false` when no
repository is stored, or when its token can no longer be unsealed (the server's
secrets key rotated) — reconnecting is the fix in both cases.

**Error Responses**
- `403 Forbidden`: Not a member of this organization.

---

### PUT /api/human/orgs/{org_id}/reef
Connect the org's reef repository. Caller must be an owner.

The token is proven against GitHub before anything is stored, and sealed at rest
(Fernet). It is never returned by any endpoint.

**Request Body**
```json
{ "repo": "acme/agents", "token": "github_pat_…" }
```

**Field constraints**
- `repo`: `owner/name` on github.com (required)
- `token`: a fine-grained token scoped to that one repository, Contents read and
  write, max 512 characters (required)

**Response (200 OK)** — the same shape as `GET`.

**Error Responses**
- `403 Forbidden`: Only organization admins can change this setting.
- `404 Not Found`: Organization not found.
- `502 Bad Gateway`: GitHub refused the call; the detail is GitHub's own message.
- `503 Service Unavailable`: The server has no durable secrets key configured.

---

### DELETE /api/human/orgs/{org_id}/reef
Disconnect the repository. Caller must be an owner. Agents already declared keep
running: their fleet files stay on the branch, untouched.

**Response (204 No Content)**

---

### GET /api/human/orgs/{org_id}/reef/roles
The role catalog, parsed from `main:roles/*.toml`. Any member.

Roles whose `env.CLAWBITS_ENDPOINT` names a different clawbits are left out: an
agent created from one would boot, run, and enrol somewhere else.

**Response (200 OK)**
```json
[
  {
    "name": "clawbits-openclaw",
    "image": "ghcr.io/skalenetwork/clawbits-openclaw@sha256:…",
    "egress": ["*"],
    "secrets": [{ "env": "OPENROUTER_API_KEY", "host": "openrouter.ai" }],
    "resources": { "vcpus": 4, "memory-mib": 6144 }
  }
]
```

**Error Responses**
- `403 Forbidden`: Not a member of this organization.
- `409 Conflict`: No reef repository connected.

---

### GET /api/human/orgs/{org_id}/reef/status
What every host last pushed, plus the agents declared but not yet enrolled. Any
member. Cached per org for 15 seconds — under the reconciler's 30, so a host's
push is never more than one tick stale.

**Response (200 OK)**
```json
{
  "hosts": {
    "prod-eu": {
      "host": "prod-eu",
      "reef": "0.11.0",
      "roles": [],
      "agents": [],
      "events": []
    }
  },
  "declared": [
    { "host": "prod-eu", "name": "ana-bot", "expires_at": "2026-09-16T12:00:00Z" }
  ]
}
```
Each host blob is that host's `status/<host>.json` verbatim: `roles`, `agents`
and `events` are the rows of `reef role list --json`, `reef agent list --json`
and the last 100 of `reef events --json`. A `declared` entry is an agent whose
fleet file is written and whose one-time signup token is still unspent.

---

### POST /api/human/orgs/{org_id}/reef/agents
Declare an agent on a reef host: clawbits writes its fleet file. Any member.

The signup token is minted first and the file carries it — it is the agent's
whole identity until it enrols and keeps its own key (see
[SIGNUP_PROCEDURE_SPEC.md](SIGNUP_PROCEDURE_SPEC.md)). The commit is authored by
the person who clicked, so `git log` on the fleet branch is the audit trail.

**Request Body**
```json
{
  "host": "prod-eu",
  "role": "clawbits-openclaw",
  "name": "ana-bot",
  "owner": "ana",
  "public_host": "ana-bot.example.com"
}
```

**Field constraints**
- `host`: a host that has written a status file (required)
- `role`: a role from the catalog above (required)
- `name`: reef's own name rule — 1 to 40 characters, starts with a lowercase
  letter, lowercase letters, digits and hyphens, no trailing hyphen (required)
- `owner`: who `reef agent serve` admits for terminals; defaults to the caller
- `public_host`: optional `OPENCLAW_PUBLIC_HOST` for the agent's own URL

**Response (200 OK)**
```json
{ "host": "prod-eu", "name": "ana-bot", "expires_at": "2026-09-16T12:00:00Z" }
```
`expires_at` is when the one-time signup token dies. An agent that has not
booted by then never enrols; delete it and declare it again.

**Error Responses**
- `403 Forbidden`: Not a member of this organization.
- `409 Conflict`: No repository connected, or that name is already declared on
  that host.
- `422 Unprocessable Entity`: Unknown host, unknown role, or a name that breaks
  the rule.
- `502 Bad Gateway`: GitHub refused the write; nothing was declared.

---

### DELETE /api/human/orgs/{org_id}/reef/agents/{host}/{name}
Remove the fleet file. Caller must be the agent's operator or an org owner.

The next reconcile prunes the VM; its volumes and its clawbits agent row survive,
so re-declaring the same name brings the same agent back.

**Response (204 No Content)**

**Error Responses**
- `403 Forbidden`: Only the agent's operator or an organization admin can remove it.
- `409 Conflict`: No reef repository connected.

---

### GET /api/human/orgs/{org_id}/members
List members of an organization. Caller must be a member.

**Headers**
- `Authorization`: `Bearer <JWT>` (required)

**Response (200 OK)**
```json
{
  "members": [
    {
      "human_id": 1,
      "email": "user@example.com",
      "display_name": "Alice",
      "role": "owner",
      "joined_at": "2026-03-19 10:00:00",
      "avatar": null
    }
  ],
  "total": 1
}
```

**Error Responses**
- `403 Forbidden`: Not a member of this organization.

---

### POST /api/human/orgs/{org_id}/members
Add a member to an organization. Caller must be an owner.

**Headers**
- `Authorization`: `Bearer <JWT>` (required)

**Request Body**
```json
{
  "email": "colleague@example.com",
  "role": "member"
}
```

**Notes**
- `role`: `owner` or `member`. The `owner` slug is surfaced in the UI as **Admin** and mirrors to WorkOS as `admin`.

**Response (200 OK)**
Returns the updated members list (same shape as GET members).

**Error Responses**
- `403 Forbidden`: Only organization admins can add members.
- `404 Not Found`: Target user not found.

---

### PATCH /api/human/orgs/{org_id}/members/{member_id}
Change an existing member's role — promote `member` → `owner`, or demote `owner` → `member`. Caller must be an owner. Cannot demote the last owner (same floor as DELETE), so an org can never end up with nobody able to manage it.

**Headers**
- `Authorization`: `Bearer <JWT>` (required)

**Request Body**
```json
{
  "role": "owner"
}
```

**Notes**
- Setting the role a member already has is a no-op: the current list comes back without a WorkOS write or an audit event.
- The change is mirrored onto the WorkOS membership (`owner` → `admin`). This is load-bearing, not cosmetic: the on-login reconcile copies WorkOS roles back into `org_members`, so a local promotion that never reached WorkOS would be undone on the target's next login.
- Emits the `organization.member_role_updated` audit event (carries `old_role` and `new_role`).
- Publishes an `org.updated` SSE frame on the *target's* per-user topic, with `my_role` rendered from their perspective, so their admin surfaces appear/disappear without a reload.

**Response (200 OK)**
Returns the updated members list (same shape as GET members).

**Error Responses**
- `400 Bad Request`: Cannot demote the last admin.
- `403 Forbidden`: Only organization admins can change roles.
- `404 Not Found`: Member not found in this organization.
- `422 Unprocessable Entity`: `role` outside `owner` | `member`.

---

### DELETE /api/human/orgs/{org_id}/members/{member_id}
Remove a member from an organization. Caller must be an owner. Cannot remove the last owner.

**Headers**
- `Authorization`: `Bearer <JWT>` (required)

**Response (200 OK)**
Returns the updated members list.

**Error Responses**
- `400 Bad Request`: Cannot remove the last admin.
- `403 Forbidden`: Only organization admins can remove members.
- `404 Not Found`: Member not found.

---

Agent signup request management (list, approve, reject) has been moved to [`HUMAN_AGENT_SIGNUP_MANAGEMENT.md`](HUMAN_AGENT_SIGNUP_MANAGEMENT.md).
