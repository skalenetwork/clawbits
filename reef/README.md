# Reef reconciler

Git is the bus between clawbits and a reef host. This directory is the whole
host side of it: a shell script and a timer. There is no daemon, no port, and
nothing on the network reaches the host — it pulls.

```text
main    roles/*.toml                platform team, by reviewed pull request
fleet   fleet/<host>/<name>.toml    clawbits, one file per agent
status  status/<host>.json          each host, from this timer
```

Every 30 seconds the host pulls all three, and when `main` or `fleet` has moved
it runs `reef role apply` and `reef fleet apply --prune`. Then it writes what
`reef` observed to `status/<host>.json` and pushes, but only when the content
changed — the commit is the timestamp.

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

Give the host a deploy key with **write** access — it has to push status — and
add it to the repository. A ruleset on `main` and `fleet` keeps that key off
both.

```sh
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 -C "reef@$(hostname)"
ssh -o StrictHostKeyChecking=accept-new -T git@github.com || true
cat ~/.ssh/id_ed25519.pub
```

One clone per branch, so `git pull --ff-only` is the only git the timer ever
needs:

```sh
mkdir -p ~/agents
for branch in main fleet status; do
  git clone --branch "$branch" --single-branch git@github.com:ORG/REPO.git ~/agents/"$branch"
done
git -C ~/agents/status config user.name  reef
git -C ~/agents/status config user.email reef@example.com
printf 'version = 1\n' > ~/agents/empty.toml
```

`empty.toml` declares no agents. It is passed to every `fleet apply` so
`--prune` stays meaningful when this host has no fleet files: reef bails when
handed nothing, and a partial file list with `--prune` deletes every agent it
cannot see.

Install the script and the timer, naming this host — the name is the directory
under `fleet/` and the file under `status/`, and it is what people pick in
clawbits:

```sh
install -m 755 reconcile.sh ~/agents/reconcile.sh
sudo install -m 644 reef-reconcile.service reef-reconcile.timer /etc/systemd/system/
sudo systemctl edit reef-reconcile.service      # [Service] Environment=REEF_HOST=prod-eu
sudo systemctl enable --now reef-reconcile.timer
```

`REEF_REPO` (default `~/agents`) and `REEF` (default `~/.local/bin/reef`)
override the rest.

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
