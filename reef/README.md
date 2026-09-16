# Reef reconciler

Git is the bus between clawbits and a reef host. This directory is the whole
host side of it: a shell script and a timer. There is no daemon, no port, and
nothing on the network reaches the host: it pulls.

```text
main    roles/*.toml                platform team, by reviewed pull request
fleet   fleet/<host>/<name>.toml    clawbits, one file per agent
status  status/<host>.json          each host, from this timer
```

Every 30 seconds the host pulls `main` and `fleet`, and when either has moved
it runs `reef role apply` and `reef fleet apply --prune`. When neither has, it
runs `reef reconcile`, which starts any agent that died since, after a reboot or
a crashed gateway, and prints only when that fails. Then it writes what
`reef` observed to `status/<host>.json`, and only when the content changed does
it commit, rebase onto `status` and push. Each host touches only its own file,
so the rebase never conflicts, and a push that loses a race goes out on the
next tick. Besides the rows of `reef role list`, `reef agent list` and the last
100 of `reef events`, the file carries:

```text
at       heartbeat: the current UTC time rounded down to ten minutes
applied  {main, fleet}: the HEADs last applied in full, null until one lands
result   ok, or failed when this tick's apply or reconcile failed
error    the cause reef printed when it failed, else null
```

`at` is what keeps an idle host committing, about every ten minutes and never
on every tick. clawbits calls a host live while its heartbeat is under 25
minutes old, stale after that, and failing whenever `result` is `failed`.

A host that cannot reach the repository changes nothing. An apply that fails
leaves the recorded HEADs alone, so the next tick retries it, and the status
file still goes out: a failed agent's state and reason are the only diagnosis
the org gets. `journalctl -u reef-reconcile` has the rest.

## Set up a host

Prepare the machine first: [reef's host
guide](https://reef.clawbits.ai/docs/setup/host) covers `msb`, KVM, the `reef`
account and the state directory. Skip its boot unit: this timer already brings
agents back after a reboot. Then, as `reef`, put the provider secrets in
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
per branch so the timer only fast-forwards `main` and `fleet` and rebases its
own commits onto `status`, and installs the script and the timer with a drop-in
carrying this machine's account, paths and host name. It also writes
`empty.toml`, which declares no agents and is passed to every `fleet apply`:
reef bails when handed no files, and a partial list with `--prune` deletes
every agent it cannot see.

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

The last one is the liveness signal the org sees: while the timer runs, the
status commit advances at least every ten minutes.

Once a status file lands, the host appears in clawbits under Settings → Reef and
people can create agents on it. Nothing else on this host is ever contacted.
