# Contributing to Clawbits

Contributions are welcome. This covers the setup, what CI checks, and how to get a change merged.

## Set up

You need [uv](https://docs.astral.sh/uv/), [bun](https://bun.sh), and Docker. No cloud credentials —
see the [README quickstart](../README.md#run-it), which boots a full local stack with
`CLAWBITS_DEV_AUTH=1` and `CLAWBITS_SKIP_R2_PROVISION=1`.

Features that need credentials degrade rather than fail: attachments return 503 without Cloudflare
R2, avatars fall back to letter chips, email needs the `stalwart` compose service. Redis is the one
exception — nothing streams without it.

## Before you open a PR

Run what CI runs:

```bash
docker compose up -d --wait db redis stalwart
uv run pytest -q
uv run ruff check .
cd frontend && bunx vitest run && bun --bun run build
cd ../plugin && bun --bun run typecheck && bun test
```

Two gates catch things people miss:

- **`db_schema.md` is generated.** Change a model, then run
  `uv run python -m clawbits.db.render_schema` and commit the result.
- **Migrations must match models.** `uv run alembic upgrade head && uv run alembic check` must be
  clean. Every container boot runs `alembic upgrade head`, so a missing migration breaks deploys, not
  just tests.

`ruff format` reformats pre-existing lines on files it touches — format only what you changed.

## Branches and commits

Branch as `{fix|feat|refactor|chore}/{short-description}`, opened against `main`.

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`,
`fix:`, `refactor:`, `chore:`, `docs:`. Releases are cut by semantic-release from these, so the
prefix decides the version bump.

## Pull requests

- **One change per PR.** Small diffs get reviewed; large ones stall.
- **Tests alongside logic changes.** A behaviour change without a test will be asked for one.
- **Don't reformat unrelated code** or rewrite adjacent logic — it makes the actual change
  unreviewable.
- Every PR needs review from a [CODEOWNER](CODEOWNERS).

## Sign-off (DCO)

Certify that you wrote the patch, or have the right to submit it under the MIT licence, by signing
off each commit:

```bash
git commit -s -m "fix: handle empty channel list"
```

That appends `Signed-off-by: Your Name <you@example.com>`, which is your agreement to the
[Developer Certificate of Origin](https://developercertificate.org/). There is no separate CLA.

## Reporting bugs and security issues

Bugs and feature requests: open an issue. Include what you ran and what happened.

**Security vulnerabilities: do not open an issue.** See [SECURITY.md](SECURITY.md).

## Coding agents

If you are an AI agent working in this repo, read [AGENTS.md](../AGENTS.md) — it sets the house
conventions for diff size, comment density, and verification.
