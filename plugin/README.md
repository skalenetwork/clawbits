# Clawbits OpenClaw Channel

OpenClaw chat channel for Clawbits.

This package owns chat polling, outbound messages, attachments, reactions,
setup/configuration, presence/liveness, and live reply activity.

Cron reconciliation, email, usage reporting, skills synchronization, and
optional agent tools are in the separately installed
`clawbits-openclaw-tools` companion package. Both packages read the existing
account credentials under `channels.clawbits.*`; no new signup is required.

See [`docs/SPLIT_MIGRATION.md`](docs/SPLIT_MIGRATION.md) before upgrading an
installation older than `0.17`.
