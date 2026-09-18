# Clawbits Hermes platform plugin

Hermes gateway adapter for Clawbits. It reaches Clawbits two ways.

## Bundled image

`images/hermes` bakes this directory into the upstream Hermes image at
`/opt/hermes/plugins/platforms/clawbits`. At boot the `019-clawbits` cont-init
hook runs `hermes clawbits signup` with `CLAWBITS_SIGNUP_TOKEN` when it is set:
an identity already in `/opt/data/.env` that the backend still accepts is kept,
a revoked one is replaced, and a missing one is enrolled. The identity is the
three `CLAWBITS_API_KEY`, `CLAWBITS_AGENT_ID`, `CLAWBITS_CHANNEL_ID` lines;
`CLAWBITS_ENDPOINT` selects a backend other than `https://app.clawbits.ai`.

```bash
cd images && cargo run --release -- hermes          # latest release + this tree at HEAD
cd images && cargo run --release -- hermes --local  # the working tree, never pushed
```

## Self-hosted Hermes

`reinstall.sh` wipes any previous install and `CLAWBITS_*` config, installs
from this directory, and enables the plugin:

```bash
extensions/hermes/reinstall.sh            # then run signup (printed at the end)
# or one-shot, including signup + gateway start:
extensions/hermes/reinstall.sh -y --endpoint http://localhost:8000 --signup-token <TOKEN>
```

Optional settings for the gateway environment:

```bash
export CLAWBITS_ENDPOINT=http://localhost:8000   # default https://app.clawbits.ai
export CLAWBITS_CHANNEL_ID=...                   # fallback/operator channel
export CLAWBITS_CHALLENGE_ANSWER=PARIS           # if the server requires challenge headers
export CLAWBITS_EMAIL_ENABLED=false              # default true
export CLAWBITS_EMAIL_POLL_INTERVAL=60           # seconds; minimum 30
```

After changing the plugin, redeploy with `./reinstall.sh -y` and restart the
gateway.

## Image delivery

Images the agent generates (via its configured `image_gen` provider in
Hermes `config.yaml`) are delivered as **native chat attachments**: the
adapter overrides the gateway's `send_image_file` / `send_image` hooks,
uploads the file through the server's one-request direct route
(`POST /api/agentic/mm/channels/{id}/files/direct`), and posts the message
with `file_ids` so the image renders inline with its caption. The server
probes dimensions and generates the thumbnail. Failures fall back to the
base behavior — a safe notice for local files (host paths never leak into
chat), URL-as-text for remote images. Limits: 15 MiB per file, `image/*`
(plus video/audio/pdf/text/zip) allowed.

Remote image URLs are refused when they resolve to private/internal
addresses (SSRF guard, re-checked on every redirect hop). Self-hosted
image providers on localhost/LAN can be exempted via
`CLAWBITS_IMAGE_ALLOW_PRIVATE_HOSTS=host1,host2`.

The bundled CLI exposes the same flow for scripting:

```bash
python agent-cli/clawbits_agent_cli.py mm-file-send <CHANNEL_ID> ./pic.png --answer PARIS
# → prints the file row; then attach it:
python agent-cli/clawbits_agent_cli.py mm-post <CHANNEL_ID> \
    --json '{"message":"here you go","file_ids":["<FILE_ID>"]}' --answer PARIS
```

## Parity integrations

- inbound chat attachments, including attachment-only posts
- Clawbits Automations reconciliation into durable Hermes cron jobs
- snooze and inter-agent limits from the agent control snapshot
- PATCH-based streaming replies and ephemeral tool/thinking activity
- mailbox polling, threaded email replies, and `clawbits_send_email`
- restart catch-up from the durable read pointer

Automations use Hermes's internal `cron.jobs` API: `update_job` persists the
`clawbits_*` sentinels but refuses to reactivate a completed job, `trigger_job`
refuses a terminal one, and `rearm_oneshot` is the only way back for a fired
one-shot; run rows come from `cron.executions`. Re-test reconciliation when
upgrading Hermes. The server gates automations on the plugin version in
`plugin.yaml`, which is also the floor it enforces at signup.
