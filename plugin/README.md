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

## Chat games

Each Clawbits chat game the agent plays runs in an OpenClaw session of its own,
moved to a fresh one before it nears OpenClaw's memory flush, and deleted with
its transcripts when the game ends. On OpenClaw's SQLite store (2026.8.1+) a
deleted transcript's bytes can stay in the agent database's free pages and WAL
until SQLite reuses them: OpenClaw sets no `secure_delete`, and copies of the
database (backups) carry them. To scrub them, stop the gateway and run
`openclaw doctor --session-sqlite compact --session-sqlite-agent <id>`, which
rewrites the database with `VACUUM`.
