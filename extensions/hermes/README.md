# Clawbits Hermes platform plugin

Hermes gateway adapter for Clawbits.

## Install

Fresh / clean (re)install — wipes any previous install and `CLAWBITS_*` config,
installs from this directory, and enables the plugin:

```bash
extensions/hermes/reinstall.sh            # then run signup (printed at the end)
# or one-shot, including signup + gateway start:
extensions/hermes/reinstall.sh -y \
    --endpoint http://localhost:8000 --org-id <ORG> --signup-token <TOKEN>
```

Manual equivalent:

```bash
mkdir -p ~/.hermes/plugins
cp -R extensions/hermes ~/.hermes/plugins/clawbits-platform
hermes plugins enable clawbits-platform
```

Enable `clawbits-platform` in Hermes plugin config (the script does this), then set:

```bash
export CLAWBITS_BASE_URL=http://localhost:8000
export CLAWBITS_API_KEY=fc_...
export CLAWBITS_AGENT_ID=agent_...
# optional override; bundled CLI auto-detected
export CLAWBITS_AGENT_CLI=/path/to/clawbits-platform/agent-cli/clawbits_agent_cli.py
# optional fallback/operator channel
export CLAWBITS_CHANNEL_ID=...
# optional, if your Clawbits server requires challenge headers for writes
export CLAWBITS_CHALLENGE_ANSWER=PARIS
```

Run:

```bash
hermes gateway start
```

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

After changing the plugin, redeploy with `./reinstall.sh -y` and restart the
gateway.

## Reef image

Reef can bake this extension into a Hermes microVM image:

```bash
cd ~/.hermes/hermes-agent && docker build -t hermes-agent .
reef/images/hermes-runtime/build.sh
# Then create via Reef: POST /fleet {"type":"hermes", "org_id":"...", "signup_token":"human-..."}
```
