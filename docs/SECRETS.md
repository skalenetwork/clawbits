# Secrets & environment variables

Clawbits uses [dotenvx](https://dotenvx.com) for per-env secrets. Each env has
one file, encrypted with a public key.

**The files live in the private `clawbits-internal` repo, not this one.** They
are gitignored here and copied in on demand:

```bash
scripts/sync_env.sh                 # development (the default)
scripts/sync_env.sh --all           # all three
scripts/sync_env.sh --check --all   # exit 1 if a local copy is stale
```

`sync_env.sh` resolves `clawbits-internal` as a sibling directory, or from
`$CLAWBITS_INTERNAL`. Values travel between the team in git (encrypted, so the
history is reviewable); the decryption key travels via 1Password. Because the
copies are gitignored, `git status` cannot tell you one is stale — that is what
`--check` is for, and `scripts/start_server.sh` runs it as an advisory warning.

Private keys live in `.env.keys` (gitignored) on laptops, and as Komodo *secret*
variables on staging/prod hosts. Only the real secrets are encrypted — URLs,
flags, and public IDs stay plaintext so `git diff` is readable.

**Outside contributors need none of this:** `cp .env.example .env` gives a
working local stack with attachments, real auth, and email disabled.

| File              | Committed? | What's in it |
|-------------------|------------|--------------|
| `.env.development` | ✅ encrypted | Local dev — `localhost:5173`, dev-auth on |
| `.env.staging`    | ✅ encrypted | `clawbits.ai` — WorkOS `sk_test_…` |
| `.env.production` | ✅ encrypted | `clawbits.ai` — WorkOS `sk_live_…` |
| `.env.keys`       | ❌ gitignored | All `DOTENV_PRIVATE_KEY_*` you have access to |
| `.env.example`    | ✅ plaintext | Schema reference + dev defaults, no secrets |

## Quick reference

```bash
dotenvx decrypt -f .env.development --stdout    # full plaintext view
dotenvx get -f .env.development --pretty-print  # JSON view
dotenvx get WORKOS_API_KEY -f .env.development  # one value
dotenvx set OPENAI_KEY sk-… -f .env.staging     # add or rotate
dotenvx run -f .env.staging -- <command>        # run with env loaded
```

## Setting up a local dev server

```bash
brew install dotenvx/brew/dotenvx     # or: curl -sfS https://dotenvx.sh | sh
echo 'DOTENV_PRIVATE_KEY_DEVELOPMENT=<paste from 1Password>' > .env.keys
scripts/restart_server.sh                    # or just use the launch.json `backend` config
```

`scripts/restart_server.sh` and `.claude/launch.json` already wrap themselves with
`dotenvx run -f .env.development`. Tests too: `dotenvx run -f .env.development -- pytest`.

## Adding or rotating a variable

```bash
dotenvx set OPENAI_KEY sk-proj-… -f .env.development
dotenvx set OPENAI_KEY sk-proj-… -f .env.staging
dotenvx set OPENAI_KEY sk-proj-… -f .env.production
git add .env.development .env.staging .env.production
git commit -m "rotate OPENAI_KEY"
```

For non-secrets (URLs, flags, public IDs), follow up with `dotenvx decrypt -k KEY -f .env.<env>`
on each file so the value stays readable in diffs. Then redeploy via Komodo to
pick up the new image.

## Setting up a new env in Komodo

For each new environment (e.g. `staging`, `production`):

1. **Create the env file** (one-time, locally):

   ```bash
   cp .env.example .env.<name>
   # edit values
   dotenvx encrypt -f .env.<name>           # encrypts everything
   dotenvx decrypt -k CLAWBITS_BASE_URL -k CLAWBITS_FRONTEND_URL \
                   -k CLAWBITS_ENV -k WORKOS_CLIENT_ID -k CLOUDFLARE_ACCOUNT_ID \
                   -k CLOUDFLARE_BUCKET -k CUSTOM_DOMAIN \
                   -k CLAWBITS_WEB_CONCURRENCY -f .env.<name>
   git add .env.<name> && git commit
   ```

2. **Add the encrypted file to the image** — append to [`Dockerfile`](../Dockerfile)'s
   `COPY … .env.development .env.staging .env.production /app/` line.

3. **Add four Komodo variables** (*Settings → Variables*, each marked *secret*):
   `DOTENV_PRIVATE_KEY_<ENV>` (from `.env.keys`) and `POSTGRES_PASSWORD_<ENV>`
   (`openssl rand -base64 32`). Mirror to 1Password for break-glass.

4. **Stack `environment:` block** — three lines:

   ```yaml
   APP_ENV: <name>
   DOTENV_PRIVATE_KEY_<NAME>: "[[DOTENV_PRIVATE_KEY_<NAME>]]"
   POSTGRES_PASSWORD: "[[POSTGRES_PASSWORD_<NAME>]]"
   ```

The Dockerfile's `CMD` wraps `uvicorn` in `dotenvx run --overload -f /app/.env.${APP_ENV}`,
so the encrypted values win over anything compose pre-sets.

## Don'ts

- Don't commit `.env.keys` or any plaintext `.env` (gitignore covers it; don't override).
- Don't reuse `WORKOS_COOKIE_PASSWORD` across envs — sessions sealed in staging
  shouldn't decrypt in prod.
- Don't rotate `WORKOS_COOKIE_PASSWORD` without first pinning
  `CLAWBITS_ATTENTION_SECRETS_KEY` (encrypt like `WORKOS_API_KEY`): org LLM
  API keys for LobsterTalk cascade are Fernet-encrypted under
  `CLAWBITS_ATTENTION_SECRETS_KEY`, falling back to the cookie password —
  rotating the fallback orphans stored keys. Safe degrade (warnings + embedding-only
  behavior, agents never muted), but org owners must re-enter their keys.
  With neither variable set the server refuses to store an org LLM key at all
  (`PUT .../lobstertalk` → 503) rather than sealing it under a per-process key
  its sibling workers can't read.
- Don't keep the prod private key on a laptop after it's in Komodo + 1Password.
  Edit prod secrets from a host that already has the key, or pull/edit/push with
  a temporary local key you delete after.

## GitHub connector OAuth App

Settings → Connectors uses a **Clawbits-owned** GitHub OAuth App (not WorkOS):

| Var | Secret? | Notes |
|-----|---------|--------|
| `GITHUB_CONNECTOR_CLIENT_ID` | no | Public; leave plaintext in env files |
| `GITHUB_CONNECTOR_CLIENT_SECRET` | **yes** | Encrypt with dotenvx like `WORKOS_API_KEY` |

Callback URL (must match the App settings):
`{CLAWBITS_BASE_URL}/api/auth/connectors/github/callback`

Create the App at GitHub → Settings → Developer settings → OAuth Apps.
Scope used: `read:user` only. Tokens are discarded after profile fetch.
