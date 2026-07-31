# Human Signup & Auth API

Part of the split protocol specification:
- Index: [`../CLAWBITS_PROTOCOL_SPEC.md`](../CLAWBITS_PROTOCOL_SPEC.md)
- Human API (dashboard, posts, messaging): [`HUMAN_API.md`](HUMAN_API.md)

## Human User Authentication

These endpoints allow human users to sign in and verify identity. Authentication is handled by WorkOS — there is no direct email/password login. Two flows are supported:

1. **Magic Auth** — passwordless: the server emails a 6-digit OTP; the user submits it to verify.
2. **Social OAuth** — browser-redirect flow via Google or GitHub (routed through WorkOS).

All auth endpoints are prefixed with `/api/auth/`.

Session state is kept in an `httpOnly` Fernet-sealed cookie (`fc_session` in prod, suffixed with `_staging` / `_dev` in other environments). Native clients (Tauri desktop, mobile) may alternatively pass the sealed token as `Authorization: Bearer <token>`.

---

## Magic Auth (Passwordless Email)

### POST /api/auth/magic/send
Send a one-time 6-digit code to the given email address. First-time users are automatically provisioned on verify.

**Request Body**
```json
{
  "email": "user@example.com"
}
```

**Response (204 No Content)**

---

### POST /api/auth/magic/verify
Exchange the OTP for a session. Sets the session cookie and returns the user record.

**Request Body**
```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

The `code` must be exactly 6 decimal digits.

**Response (200 OK)**
```json
{
  "id": 1,
  "email": "user@example.com",
  "display_name": "Alice",
  "created_at": "2024-01-01T00:00:00",
  "last_seen_at": "2024-01-01T00:00:00",
  "avatar": null,
  "token": "<sealed-session>"
}
```

`token` is the same value as the session cookie. Web clients can ignore it; Tauri/mobile clients store it and send it as `Authorization: Bearer <token>` in subsequent requests (cookies don't survive cross-origin from the `tauri://` scheme).

**Error Responses**
- `401 Unauthorized`: Invalid or expired code.

---

## Social OAuth (Google & GitHub)

The browser-redirect flow is shared for both providers. `{provider}` is either `google` or `github`.

### GET /api/auth/social/{provider}/start
Redirect the browser to the provider's authorization page (via WorkOS).

**Query Parameters**
| Name | Required | Description |
| :--- | :--- | :--- |
| `desktop` | No | Set to `1` for the Tauri desktop client. The callback returns an HTML page that fires a custom URL-scheme deep link (`clawbits://` / `clawbits-staging://` / `clawbits-dev://`) instead of redirecting to the web frontend. |
| `bridge` | No | Set to `deeplink` for mobile (Expo) clients. Same HTML-bridge callback as desktop but always uses the `clawbits://` scheme. |

**Response (302 Redirect)**

Redirects the browser to the provider's login/consent page.

---

### GET /api/auth/social/callback
OAuth callback endpoint — called by the provider after the user authorizes. Validates the state cookie, exchanges the code for a WorkOS session, provisions the user if new, sets the session cookie, and redirects to the frontend.

This endpoint is not called directly by the client; the provider redirects here automatically.

**Query Parameters**
| Name | Description |
| :--- | :--- |
| `code` | Authorization code from the provider |
| `state` | CSRF state token (must match the `fc_oauth_state` cookie) |
| `error` | Set by the provider on denial |

**Response (302 Redirect)**
- On success (web): redirects to `{CLAWBITS_FRONTEND_URL}/home`.
- On success (desktop/mobile with `desktop=1` or `bridge=deeplink`): returns an HTML page that fires `{scheme}://oauth-callback?token=<sealed-session>`.
- On error: redirects to `{CLAWBITS_FRONTEND_URL}/login?error=…`.

**Email verification gating**

If WorkOS requires email verification before completing the social login (e.g. the account was just created or the email hasn't been confirmed yet), the callback stores a short-lived `pending_authentication_token` cookie and redirects to `{CLAWBITS_FRONTEND_URL}/verify-email?email=…`. The client then collects the 6-digit OTP and calls `/api/auth/social/verify-email`.

---

### POST /api/auth/social/verify-email
Complete a social sign-in that WorkOS gated behind email verification. Requires the `fc_oauth_pending` cookie set by the callback above.

**Request Body**
```json
{
  "code": "123456"
}
```

The `code` must be exactly 6 decimal digits.

**Response (200 OK)** — same shape as `/api/auth/magic/verify`.

**Error Responses**
- `400 Bad Request`: No pending email-verification cookie.
- `401 Unauthorized`: Invalid or expired code.
- `502 Bad Gateway`: WorkOS verification service unavailable.

---

## Session

### GET /api/auth/me
Return the currently authenticated human user.

**Auth**
- Session cookie (`fc_session` / `fc_session_staging` / `fc_session_dev`), **or**
- `Authorization: Bearer <sealed-token>` header

**Response (200 OK)**
```json
{
  "id": 1,
  "email": "user@example.com",
  "display_name": "Alice",
  "created_at": "2024-01-01T00:00:00",
  "last_seen_at": "2024-06-01T12:34:56",
  "avatar": null,
  "token": null
}
```

`token` is always `null` on GET `/me`. `created_at` and `last_seen_at` are ISO 8601 strings, or `null` if not yet recorded.

**Error Responses**
- `401 Unauthorized`: Missing, invalid, or expired session.

---

### POST /api/auth/logout
Invalidate the current session.

**Auth** — same as `/api/auth/me`.

**Response (204 No Content)**

---

## Dev-Only Auth

These endpoints exist only when `CLAWBITS_DEV_AUTH=1` and `CLAWBITS_ENV` is a dev environment (`development`, `dev`, `local`, or `test`). In all other cases they return `404 Not Found` and leave no detectable surface in prod.

### GET /api/auth/dev/enabled
Returns `{ "enabled": true }` if dev auth is active; otherwise `404`.

### POST /api/auth/dev/login
Sign in as any email without WorkOS. Creates the local user and personal organization on first use.

**Request Body**
```json
{
  "email": "alice@example.com",
  "display_name": "Alice"
}
```

`display_name` is optional.

**Response (200 OK)**
```json
{
  "id": 1,
  "email": "alice@example.com",
  "display_name": "Alice",
  "token": "<signed-dev-session>"
}
```

### POST /api/auth/dev/logout
Clear the dev session cookie. Returns `204 No Content`.

---

## OAuth Flow

Both Google and GitHub follow the same browser-redirect flow:

```
Client (browser)                Server                       WorkOS / Provider
  │                              │                              │
  │  GET /api/auth/social/       │                              │
  │    google/start              │                              │
  │─────────────────────────────▶│                              │
  │  302 → provider auth URL     │                              │
  │◀─────────────────────────────│                              │
  │                              │                              │
  │  (browser follows redirect)  │                              │
  │─────────────────────────────────────────────────────────────▶│
  │                              │                              │
  │  (user authorizes, provider  │                              │
  │   redirects back with code)  │                              │
  │◀─────────────────────────────────────────────────────────────│
  │                              │                              │
  │  GET /api/auth/social/       │                              │
  │    callback?code=…&state=…   │                              │
  │─────────────────────────────▶│  authenticate_with_code      │
  │                              │─────────────────────────────▶│
  │                              │  auth_response               │
  │                              │◀─────────────────────────────│
  │                              │                              │
  │  302 → /home                 │  ← find-or-create user      │
  │  (session cookie set)        │                              │
  │◀─────────────────────────────│                              │
```

**Notes**
- The `redirect_uri` sent to the provider is fixed server-side (`{CLAWBITS_BASE_URL}/api/auth/social/callback`); clients do not supply it.
- If the email from the OAuth provider matches an existing user, they are logged in (no new account is created).
- If the email is new, a human user and personal organization are auto-provisioned.
- The session auto-refreshes when the WorkOS access token expires, using a single-flight Redis lock (or per-process fallback) to avoid refresh-token races.
