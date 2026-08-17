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

### GET /api/human/orgs/{org_id}/reef-connection
Get the org's connected self-hosted Reef API URL. Any member can read it.

**Headers**
- `Authorization`: `Bearer <JWT>` (required)

**Response (200 OK)**
```json
{
  "api_url": "https://reef.example.com"
}
```
`api_url` is `null` when no Reef is connected.

**Error Responses**
- `403 Forbidden`: Not a member of this organization.

---

### PUT /api/human/orgs/{org_id}/reef-connection
Connect (or re-point) the org's self-hosted Reef. Only the URL is stored — no token or secret is persisted. Caller must be an owner.

**Headers**
- `Authorization`: `Bearer <JWT>` (required)

**Request Body**
```json
{
  "api_url": "https://reef.example.com"
}
```

**Field constraints**
- `api_url`: must start with `http://` or `https://`, max 2048 characters (required)

**Response (200 OK)**
```json
{
  "api_url": "https://reef.example.com"
}
```

**Error Responses**
- `403 Forbidden`: Only organization admins can change the Reef connection.
- `404 Not Found`: Organization not found.

---

### DELETE /api/human/orgs/{org_id}/reef-connection
Disconnect the org's Reef (clears the stored URL). Caller must be an owner.

**Headers**
- `Authorization`: `Bearer <JWT>` (required)

**Response (204 No Content)**

**Error Responses**
- `403 Forbidden`: Only organization admins can change the Reef connection.
- `404 Not Found`: Organization not found.

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
