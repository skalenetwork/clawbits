# Database & schema management

> [!IMPORTANT]
> **Never** run `SQLModel.metadata.create_all` against a production DB, edit
> [`db_schema.md`](../clawbits/db/db_schema.md) by hand, or skip generating
> a migration when you change [`models.py`](../clawbits/db/models.py). CI
> blocks merges when the migration history or the schema doc is out of sync.

The schema lives in [`clawbits/db/models.py`](../clawbits/db/models.py) as
SQLModel classes. Three pieces of tooling keep it consistent everywhere:

| Layer | Tool | What it does |
|---|---|---|
| Schema source of truth | `models.py` | Hand-edited; defines tables, columns, constraints. |
| Migration history | Alembic | One revision per change in [`clawbits/db/migrations/versions/`](../clawbits/db/migrations/versions/); applied at app startup via `run_alembic_upgrade_head()`. |
| Human reference | [`db_schema.md`](../clawbits/db/db_schema.md) | **Auto-generated** by [`render_schema.py`](../clawbits/db/render_schema.py) — read-only artifact. |

## Adding or changing a column

Five-step workflow. CI fails if you skip step 3 or 4.

```bash
# 1. Edit the model.
$EDITOR clawbits/db/models.py

# 2. Generate the migration. Alembic diffs the live DB against models.py
#    and writes a new revision to clawbits/db/migrations/versions/.
uv run alembic revision --autogenerate -m "short imperative summary"

# 3. Read the generated migration. Autogenerate covers ~95% of common cases
#    but does NOT detect: column renames (it sees drop+add — fix manually),
#    custom CHECK constraint changes, or data backfills. Edit the file if
#    you need to.

# 4. Apply it locally and verify there's no drift.
uv run alembic upgrade head
uv run alembic check     # must print "No new upgrade operations detected."

# 5. Regenerate the schema doc.
uv run python -m clawbits.db.render_schema

# 6. Commit all three together.
git add clawbits/db/models.py \
        clawbits/db/migrations/versions/ \
        clawbits/db/db_schema.md
```

## Other common operations

```bash
uv run alembic current               # what revision is the DB at?
uv run alembic history               # full migration log
uv run alembic upgrade head          # bring DB to latest
uv run alembic downgrade -1          # roll back one revision (if downgrade impl'd)
uv run alembic stamp head            # mark DB as already-at-head without running

# Wipe and rebuild the local dev DB from scratch.
docker exec clawbits-db-1 psql -U clawbits -d postgres -c "DROP DATABASE clawbits"
docker exec clawbits-db-1 psql -U clawbits -d postgres -c "CREATE DATABASE clawbits"
uv run alembic upgrade head
```

## Conventions

- **All timestamp columns are `TIMESTAMPTZ` (TZ-aware).** Use the helper
  [`_server_now_column()`](../clawbits/db/models.py) for created/updated
  defaults. For nullable timestamps without a default, declare an explicit
  `SAColumn(SADateTime(timezone=True), nullable=True)`. Application-side
  writes use `datetime.now(timezone.utc)` — never naive `datetime.now()`.
- **JSON-shaped columns use `JSONB`**, not `TEXT` with `json.dumps`. See
  `MmPost.link_preview` for the pattern.
- **Hashed credentials, never plaintext.** API keys are stored as
  `*_hash` columns (sha256). Don't store secrets the app could re-read.
- **Soft-delete via `deleted_at: datetime | None`**, not a `status` enum.
- **Org-level role is canonical.** There is no global user role on
  `human_users`; authorisation reads `org_members.role`.

## How the server applies migrations

`ClawBitsServer._connect_db` calls `TableCreate.create_all_tables(engine)`
on startup, which delegates to
[`run_alembic_upgrade_head()`](../clawbits/db/engine.py). This runs
`alembic upgrade head` against `CLAWBITS_DATABASE_URL` — the same env var
the app reads for normal connections.

Tests bypass Alembic for speed: `tests/fastapi/conftest.py` runs
`DROP SCHEMA public CASCADE` once per session, then the lifespan rebuilds
the schema via the normal startup path. This means the migration pipeline
is exercised end-to-end on every test run.

## Pre-commit hook (recommended)

Catches the same drift that CI does, but locally before you push. Install
once per clone:

```bash
uv run pre-commit install
```

Now `git commit` runs:
1. `ruff check --fix` on changed Python files.
2. `render_schema.py` if you touched `models.py` or the renderer — fails the
   commit if the regenerated doc differs from what's staged. Re-stage the
   modified `db_schema.md` and commit again.

Skip with `git commit --no-verify` only if you know what you're doing — CI
runs the same gates.

## CI guard rails

[`.github/workflows/workflow.yaml`](../.github/workflows/workflow.yaml) runs
two checks on every PR:

1. `uv run python -m clawbits.db.render_schema` followed by
   `git diff --exit-code clawbits/db/db_schema.md` — fails if the doc is
   stale.
2. `uv run alembic upgrade head && uv run alembic check` — fails if
   `models.py` and the migrations have diverged.

If either fails, run the appropriate command from the workflow above and
commit the result.
