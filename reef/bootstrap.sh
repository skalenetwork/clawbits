#!/bin/sh
# Turn a prepared machine into a reef host: a deploy key, three clones, a timer.
# Run it, add the key it prints to the repository, run it again.
set -eu

: "${REEF_HOST:?REEF_HOST is required, for example prod-eu}"
: "${REEF_REPO:?REEF_REPO is required, for example acme/reef-store}"

SRC="${REEF_SRC:-https://raw.githubusercontent.com/skalenetwork/clawbits/main/reef}"
DIR="${REEF_DIR:-$HOME/agents}"
KEY="$HOME/.ssh/id_ed25519"

# The name is a directory under fleet/ and a file under status/: a host that
# names itself anything else keeps working and stays invisible.
echo "$REEF_HOST" | grep -Eq '^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$' ||
  { echo "REEF_HOST must be lowercase letters, digits and hyphens, starting with a letter" >&2; exit 1; }

# reconcile.sh builds the status file with jq: caught here, not on the timer.
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -f "$KEY" -C "reef@$REEF_HOST"

# github.com's published host key: without it the first clone stops at a prompt.
grep -q '^github.com ssh-ed25519' "$HOME/.ssh/known_hosts" 2>/dev/null ||
  echo 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' \
    >> "$HOME/.ssh/known_hosts"

if ! ssh -o BatchMode=yes -T git@github.com 2>&1 | grep -q 'successfully authenticated'; then
  echo "Add this to github.com/$REEF_REPO under Deploy keys, tick write access, then run this again:"
  cat "$KEY.pub"
  exit 1
fi

# One clone per branch, so 'git pull --ff-only' is the only git the timer needs.
for branch in main fleet status; do
  [ -d "$DIR/$branch/.git" ] ||
    git clone --quiet --branch "$branch" --single-branch "git@github.com:$REEF_REPO.git" "$DIR/$branch"
done

git -C "$DIR/status" config user.name reef
git -C "$DIR/status" config user.email "reef@$REEF_HOST"

# Declares no agents: it is what keeps --prune meaningful, see reconcile.sh.
printf 'version = 1\n' > "$DIR/empty.toml"

curl -fsSL "$SRC/reconcile.sh" -o "$DIR/reconcile.sh"
chmod 755 "$DIR/reconcile.sh"
for unit in reef-reconcile.service reef-reconcile.timer; do
  sudo curl -fsSL "$SRC/$unit" -o "/etc/systemd/system/$unit"
done

# The shipped unit carries reef's own account and paths, and no host name.
sudo mkdir -p /etc/systemd/system/reef-reconcile.service.d
sudo tee /etc/systemd/system/reef-reconcile.service.d/host.conf >/dev/null <<UNIT
[Service]
User=$(id -un)
Environment=REEF_HOST=$REEF_HOST
Environment=REEF_DIR=$DIR
ExecStart=
ExecStart=$DIR/reconcile.sh
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now reef-reconcile.timer

echo "$REEF_HOST reconciles against $REEF_REPO every 30 seconds."
