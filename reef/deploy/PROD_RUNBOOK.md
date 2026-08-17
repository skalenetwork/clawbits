# Reef production runbook - Ubuntu bare metal

Production Reef on one KVM-capable Ubuntu machine: agents run as true microVMs
under [microsandbox](https://microsandbox.dev), the API + self-healing
reconciler and the operator dashboard run under systemd, and a Cloudflare
tunnel gives it a stable HTTPS hostname.

[`install.sh`](install.sh) does all host setup in one idempotent command. Only
three things are manual: the machine itself (step 1), the git clone (step 2),
and the tunnel (step 4).

Related: [`../SETUP.md`](../SETUP.md) (full env-var reference, troubleshooting),
[`README.md`](README.md) (what the installer does under the hood),
[`../../docs/REEF.md`](../../docs/REEF.md) (design decisions).

## Setup

### 1. Machine

- **BIOS**: enable **Intel VT-x** (AMD: SVM) - without it there is no
  `/dev/kvm` and no microVMs. Optional for an office box: After Power Loss →
  **Power On**, so it comes back from outages on its own.
- Install **Ubuntu Server 24.04 LTS** with OpenSSH. (Desktop edition works too,
  but mask sleep: `sudo systemctl mask sleep.target suspend.target
  hibernate.target hybrid-sleep.target`.)

```bash
sudo apt update && sudo apt -y upgrade
sudo apt install -y cpu-checker && kvm-ok    # expect: "KVM acceleration can be used"
```

No static IP or port-forwarding needed: Reef binds loopback and the tunnel is
outbound-only. A DHCP reservation for SSH convenience is enough.

### 2. Code

The repo is private and upgrades run as root, so give root a read-only deploy
key, then clone:

```bash
sudo ssh-keygen -t ed25519 -f /root/.ssh/clawbits_deploy -N "" -C "reef-prod"
sudo cat /root/.ssh/clawbits_deploy.pub    # add on GitHub: repo → Settings → Deploy keys (write access OFF)
sudo tee -a /root/.ssh/config >/dev/null <<'EOF'
Host github.com
  IdentityFile /root/.ssh/clawbits_deploy
  IdentitiesOnly yes
EOF
sudo git clone git@github.com:skalenetwork/clawbits.git /opt/reef
```

Deploy from `main`, not a feature branch. (`/opt/reef` is the convention; any
path works - the installer renders real paths into the units.)

### 3. Install

```bash
cd /opt/reef && sudo reef/deploy/install.sh
```

Idempotent, takes a few minutes. It installs Docker (the image builder), uv +
Python + deps, and **microsandbox itself** (as the `reef` service user it
creates, with KVM access); writes `/etc/reef/reef.env` with a generated
`REEF_ADMIN_TOKEN` + `REEF_SUBDOMAIN_SECRET`; builds the agent image and loads
it into msb; builds the **operator dashboard**; and starts the systemd units
(API + reconciler, dashboard, daily DB backup). It ends by printing `/healthz`
- expect `"msb_available": true`.

Then add provider keys - fresh and spend-capped (any agent VM that receives a
key can read it, so never reuse a dev key):

```bash
sudoedit /etc/reef/reef.env    # REEF_ANTHROPIC_API_KEY=sk-ant-…  (and/or REEF_OPENAI_API_KEY / REEF_GEMINI_API_KEY / REEF_NEARAI_API_KEY / REEF_OPENROUTER_API_KEY)
sudo systemctl restart reef-api
```

Leave the generated token/secret alone. Leave `REEF_CORS_ORIGINS` unset unless
clawbits runs on a domain other than `app.clawbits.ai` - setting it **replaces**
the default list, so re-add the Tauri origins (`tauri://localhost`,
`http://tauri.localhost`, `http://localhost:5176`) or the desktop app shows
Reef as Offline.

### 4. Tunnel

Cloudflare **Zero Trust → Networks → Tunnels → Create a tunnel** (cloudflared
connector), run the printed `sudo cloudflared service install <token>` on the
server, then add a **Public Hostname**: `reef.<yourdomain>` → service
`http://127.0.0.1:8787`. This one hostname also carries every agent's Control
UI and web terminal via the `/s/{digest}/` surface proxy - no wildcard DNS or
nginx needed.

Then set the public URL - **required**, not cosmetic: every agent
Control-UI/terminal link is built on this origin; left unset they can degrade
to `http://127.0.0.1` over the tunnel and won't open:

```bash
sudoedit /etc/reef/reef.env    # REEF_PUBLIC_URL=https://reef.<yourdomain>  (exact hostname, https, no path)
sudo systemctl restart reef-api
```

### 5. Verify

```bash
curl -s 127.0.0.1:8787/healthz | python3 -m json.tool   # want: ok, msb_available, reconciler.healthy
TOKEN=$(sudo sed -n 's/^REEF_ADMIN_TOKEN=//p' /etc/reef/reef.env)

# Full smoke: create a real microVM agent, read logs, check its public links, destroy.
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"openclaw","name":"smoke","provider":"anthropic"}' 127.0.0.1:8787/fleet
curl -s -H "Authorization: Bearer $TOKEN" "127.0.0.1:8787/fleet/smoke/logs?tail=50"
curl -s -H "Authorization: Bearer $TOKEN" https://reef.<yourdomain>/fleet/smoke \
  | python3 -c 'import json,sys; a=json.load(sys.stdin)["access"]; print(a["url"]); print(a["terminal_url"])'
#   ^ both URLs must start with https://reef.<yourdomain>/s/ - loopback links mean REEF_PUBLIC_URL is wrong
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" 127.0.0.1:8787/fleet/smoke
```

Finish with a **reboot test** - the point of the systemd + reconciler setup:
create an agent, `sudo reboot`, then confirm `/healthz` comes back and the
agent reconciles to running on its own (`journalctl -u reef-api -f`).

### 6. Connect clawbits

In clawbits: **Settings → Reef** → URL `https://reef.<yourdomain>` + the admin
token (`sudo grep REEF_ADMIN_TOKEN /etc/reef/reef.env`). The browser talks to
Reef directly; the clawbits backend never does.

One trap: when creating agents, `clawbits_url` must be reachable **from inside
the microVM on this machine** - `https://app.clawbits.ai` works; the
`host.microsandbox.internal` / `host.docker.internal` presets do **not** (those
are for a Reef on the same machine as clawbits); a dev clawbits on your laptop
needs the laptop's LAN IP (`http://192.168.x.x:8000`).

## Operator dashboard

Built and started by the installer (`reef-admin-ui`). It binds **loopback
only** and must never go on the tunnel - reach it over an SSH forward:

```bash
ssh -L 8788:127.0.0.1:8788 <you>@<host>    # then open http://localhost:8788
```

The admin token gates everything (paste it in the UI). Re-running `install.sh`
rebuilds it. Tune with `REEF_ADMIN_UI_HOST` / `REEF_ADMIN_UI_PORT` (keep the
bind loopback).

## Maintenance

**Health / logs:**

```bash
curl -s 127.0.0.1:8787/healthz | python3 -m json.tool   # alert on reconciler.healthy=false
journalctl -u reef-api -f                               # reconciler heals log at INFO
sudo -u reef -H msb list    # msb's own view (per-user state - the `-u reef` matters)
```

**Upgrade:**

```bash
cd /opt/reef && sudo git pull
sudo reef/deploy/install.sh --skip-image   # re-syncs deps, rebuilds the dashboard, refreshes units
sudo systemctl restart reef-api reef-admin-ui   # store survives; agents reconcile back as managed
```

If the agent image changed, rebuild + reload it (affects **newly created**
agents; existing agents move over via the per-agent Upgrade action):

```bash
sudo bash reef/images/openclaw-runtime/build.sh
sudo docker save reef-oc:plugin -o /var/lib/reef/reef-oc.tar
sudo -u reef -H msb image load -i /var/lib/reef/reef-oc.tar && sudo rm /var/lib/reef/reef-oc.tar
```

**Backups:** `reef-db-backup.timer` snapshots `/var/lib/reef/reef.db` - the
source of truth for every agent's desired state - to `/var/backups/reef` daily
(keeps 14). For point-in-time backups run [litestream](https://litestream.io)
against the same file.

**Reboots / power loss:** recovery is automatic - systemd starts the API, the
reconciler restores every `desired_state=running` agent from the durable store.
It can restart a *stopped* VM but cannot recreate a *removed* one (those
surface as `failed`).

**One reconciler only:** this box runs `REEF_RECONCILE=1`; any additional API
process ever pointed at the same fleet must set `=0` - two reconcilers fight.

## Per-agent env vars

Set in reef admin-ui → **Environment** or on the clawbits Reef page
(`GET`/`PATCH /fleet/{id}/env`). No surface ever hands a value back.

**At rest.** Two plaintext files per agent under `/var/lib/reef`
(`$REEF_STATE_DIR`):

* `env/<agent>/env` - the overlay, mounted read-only into the guest at
  `/home/node/.reef-env`. Dropped only by `DELETE /fleet/{id}`.
* `env/<agent>+pending/env` - the agent's whole spec env, provider key and
  gateway token included. Parked while a recreate has destroyed the container
  and not built the new one, so `start` can rebuild it across a reef restart;
  dropped on the next successful create or on `DELETE`.

Leaf dirs are `0755` and files `0644` deliberately - the guest sees them as
`root:root` and its non-root uid needs the world bits, so do not tighten them.
Confidentiality is the parent chain: `/var/lib/reef` `0750` reef-owned
(`install.sh` + `StateDirectoryMode`), `env/` `0700`.

> Reef chmods `env/` only when it creates it - one that already exists with
> looser modes, hand-made or restored from a backup or inherited by a relocated
> `REEF_STATE_DIR`, is never re-permissioned. After any move or restore:
> `sudo stat -c '%a %U' /var/lib/reef /var/lib/reef/env` → want `750 reef` and
> `700 reef`.

**Apply modes.** `restart` writes the overlay and restarts in place, keeping
values off argv; it needs an image with `REEF_FEATURES=env-file` (per agent:
`apply_modes` on `GET /fleet/{id}/env`). Older agents take env changes only via
`recreate`, which passes values on `msb create -e` - world-readable in
`/proc/<pid>/cmdline` - destroys `~/.openclaw`, and writes no overlay file at
all. One `upgrade` moves an agent onto in-place restarts for good.

**Assumed**: no untrusted local users on this box (`reef` is in the `docker`
group and creates pass provider keys on argv - remount `/proc` with `hidepid=2`
if that ever changes), and the agent is trusted with its own secrets (they sit
in its `process.env`, readable from its web terminal), so keep the credentials
scoped and revocable. Reef masks known values out of `GET /fleet/{id}/logs`,
rotated-away ones included, until `reef-api` restarts - pull the logs you need
before restarting it.

### When a save or a recreate half-fails

An env save applies by restarting the agent or by destroying and rebuilding it
(`apply=recreate`, and every `upgrade`). Three outcomes, and the response names
which one you got:

* **422** - nothing was written; fix the named key and resend. The two
  surprising rules: a value may not *end* in a newline, checked against the
  whole resulting env, so an agent already carrying one refuses every save until
  that key is fixed; and keys that control how the guest loads code or which TLS
  roots it trusts (`LD_PRELOAD`, `NODE_OPTIONS`, `PATH`, `NODE_EXTRA_CA_CERTS`,
  …, full list `fleet._DANGEROUS_ENV_KEYS`) can be neither set nor unset - proxy
  vars are allowed.
* **The container survived** - a failed `restart` apply, or a destroy the
  runtime refused. Reef restores the previous overlay before returning and the
  agent goes on running the old env. Retry the same request; a `GET` on `/env`
  confirms what it actually has.
* **The destroy landed and the create did not** - the container is gone and the
  record sits at `failed` with no handle.

A `failed`, handle-less agent still lists, and `GET /fleet/{id}` answers `200`
off the record; `/env` returns `503` on read and write alike, there being no
container to read the env off; `stop` returns `404`. `start` is the fix: `200`,
rebuilding from the parked spec on the same image with the same volumes and port
forwards, running again - `upgrade` does the same onto the active image. Both
`503` when the parked spec is gone too (the container was removed outside reef,
or the stash could not be written); then only `DELETE /fleet/{id}` and a fresh
create are left.

After a failed env save the 503 wording says what the rebuilt agent will carry.
"**NOT applied - it has been rolled back in full**": the overlay is back as it
was, so `start` returns the agent with its pre-save env. "**It is now PENDING -
it will take effect when the agent comes back**": reef could not undo the
overlay it had already written, so the new values go live the moment the agent
starts, despite the error. Do not just retry - `start` it, re-read `/env`, then
set what you want.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `kvm-ok` fails / no `/dev/kvm` | Enable VT-x (SVM) in BIOS. If `/proc/cpuinfo` has `vmx`/`svm` but the device is still missing, the module is likely blacklisted: check `grep -rn kvm /etc/modprobe.d/`, comment the `blacklist kvm-intel` line, `sudo modprobe kvm_intel`, and persist with `echo kvm_intel \| sudo tee /etc/modules-load.d/kvm.conf` |
| Agent create dies: SIGABRT, `Error creating the Kvm object: Error(2)` | Same as above - `/dev/kvm` doesn't exist (`Error(13)` instead means the service user lacks the `kvm` group) |
| `healthz` shows `msb_available: false` | Check the `/usr/local/bin/msb` symlink, or set `REEF_MSB_BIN` in `/etc/reef/reef.env`; restart |
| Agent create fails: permission on `/dev/kvm` | `sudo usermod -aG kvm reef && sudo systemctl restart reef-api` |
| Agent create fails: image not found | Re-run the image rebuild + `msb image load` pair (Upgrade above) |
| `401` on `/fleet` | Wrong/missing bearer token - compare with `/etc/reef/reef.env` |
| Desktop app shows Reef Offline, browser works | Custom `REEF_CORS_ORIGINS` replaced the defaults - re-add the Tauri origins |
| Agent up but never enrolls in clawbits | `clawbits_url` not reachable from inside the VM (step 6) |
| Dashboard 404 / not running | UI build failed or `--skip-ui` - re-run `install.sh`, then `sudo systemctl enable --now reef-admin-ui` |

Full table: [`../SETUP.md`](../SETUP.md#troubleshooting).
