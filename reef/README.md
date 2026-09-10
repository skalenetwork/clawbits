# Reef reconciler

Git is the bus between clawbits and a reef host. This directory is the whole
host side of it: a shell script and a timer. There is no daemon, no port, and
nothing on the network reaches the host: it pulls.

```text
main    roles/*.toml                platform team, by reviewed pull request
fleet   fleet/<host>/<name>.toml    clawbits, one file per agent
status  status/<host>.json          each host, from this timer
```

Every 30 seconds the host pulls all three, and when `main` or `fleet` has moved
it runs `reef role apply` and `reef fleet apply --prune`. Then it writes what
`reef` observed to `status/<host>.json` and pushes, but only when the content
changed: the commit is the timestamp.

A host that cannot reach the repository changes nothing. An apply that fails
leaves the recorded HEADs alone, so the next tick retries it, and the status
file still goes out: a failed agent's state and reason are the only diagnosis
the org gets. `journalctl -u reef-reconcile` has the rest.

## Set up a host

Prepare the machine first: [reef's host
guide](https://reef.clawbits.ai/docs/setup/host) covers `msb`, KVM, the `reef`
account and the state directory. Then, as `reef`, put the provider secrets in
`~/.local/state/reef/secrets.toml` (`chmod 600`) and check `reef doctor`.

`jq` and `git` are the only extra packages this needs.

Then run `bootstrap.sh`, naming this host. The name is the directory under
`fleet/` and the file under `status/`, and it is what people pick in clawbits,
so it follows reef's own rule: lowercase letters, digits and hyphens, starting
with a letter.

```sh
curl -fsSL https://raw.githubusercontent.com/skalenetwork/clawbits/main/reef/bootstrap.sh |
  REEF_HOST=prod-eu REEF_REPO=acme/reef-store sh
```

It makes an ed25519 key, pins github.com's published host key, clones one tree
per branch so `git pull --ff-only` is the only git the timer ever needs, and
installs the script and the timer with a drop-in carrying this machine's
account, paths and host name. It also writes `empty.toml`, which declares no
agents and is passed to every `fleet apply`: reef bails when handed no files,
and a partial list with `--prune` deletes every agent it cannot see.

The first run stops after the key: nothing else is possible until that key is
on the repository. Add it under **Settings → Deploy keys** with **Allow write
access**, which the host needs so it can push its status, then run the same
line again. Protect `main` and `fleet` with a ruleset so the key can only ever
push `status`.

`REEF_DIR` (default `~/agents`) moves the trees and bootstrap writes it into
the drop-in. `reconcile.sh` finds reef at `REEF`, default `~/.local/bin/reef`.

## Check it

```sh
systemctl list-timers reef-reconcile.timer
journalctl -u reef-reconcile -n 50
git -C ~/agents/status log -1 --format='%cr'
```

The last one is the liveness signal the org sees: when the status commit stops
advancing, this timer stopped.

Once a status file lands, the host appears in clawbits under Settings → Reef and
people can create agents on it. Nothing else on this host is ever contacted.
