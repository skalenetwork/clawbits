#!/bin/sh
set -eu

: "${REEF_HOST:?REEF_HOST is required, for example prod-eu}"
: "${REEF_REPO:?REEF_REPO is required, for example acme/reef-store}"

SRC="${REEF_SRC:-https://raw.githubusercontent.com/skalenetwork/clawbits/main/reef}"
DIR="${REEF_DIR:-$HOME/agents}"
KEY="$HOME/.ssh/id_ed25519"

echo "$REEF_HOST" | grep -Eq '^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$' ||
  { echo "REEF_HOST must be lowercase letters, digits and hyphens, starting with a letter" >&2; exit 1; }

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -f "$KEY" -C "reef@$REEF_HOST"

grep -q '^github.com ssh-ed25519' "$HOME/.ssh/known_hosts" 2>/dev/null ||
  echo 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' \
    >> "$HOME/.ssh/known_hosts"

if ! ssh -o BatchMode=yes -T git@github.com 2>&1 | grep -q 'successfully authenticated'; then
  echo "Add this to github.com/$REEF_REPO under Deploy keys, tick write access, then run this again:"
  cat "$KEY.pub"
  exit 1
fi

for branch in main fleet status; do
  [ -d "$DIR/$branch/.git" ] ||
    git clone --quiet --branch "$branch" --single-branch "git@github.com:$REEF_REPO.git" "$DIR/$branch"
done

git -C "$DIR/status" config user.name reef
git -C "$DIR/status" config user.email "reef@$REEF_HOST"

printf 'version = 1\n' > "$DIR/empty.toml"

if [ -f /etc/systemd/system/reef-reconcile.timer ]; then
  sudo systemctl disable --now reef-reconcile.timer
  sudo rm /etc/systemd/system/reef-reconcile.timer
fi

curl -fsSL "$SRC/reconcile.sh" -o "$DIR/reconcile.sh"
chmod 755 "$DIR/reconcile.sh"
sudo curl -fsSL "$SRC/reef-reconcile.service" -o /etc/systemd/system/reef-reconcile.service

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
sudo systemctl enable reef-reconcile
sudo systemctl restart reef-reconcile

echo "$REEF_HOST reconciles against $REEF_REPO every few seconds."
