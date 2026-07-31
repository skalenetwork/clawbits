# Reef admin UI

The operator dashboard for [Reef](../README.md) — a fleet view + lifecycle control
over agent microVMs, on top of the [admin/fleet API](../api/app.py).

Standalone and **separate from the customer app** (clawbits' `frontend/`), per
docs/REEF.md §10: this is an internal, network-isolated operator surface.

## Stack

Vite 8 + React 19 + TypeScript + Tailwind v4 + TanStack Query, with Base UI
primitives and HugeIcons. No backend coupling — it talks to the Reef API over HTTP.

## Design

Reuses the clawbits app's design tokens (`src/index.css` — OKLCH palette, shadows,
Inter / JetBrains Mono, liquid-glass scrollbars) for a consistent look, with a
single **vermilion `--brand`** accent. Light / dark / system (appearance menu in
the sidebar footer; default dark); primitives in `src/components/ui/` mirror
clawbits' `button` / `input` variants.

## Run it

1. Start the Reef API (from the repo root):

   ```bash
   uv run python -m reef.api          # serves http://127.0.0.1:8787
   # macOS uses the Docker runtime by default; set REEF_RUNTIME=microsandbox for msb.
   ```

2. Start the UI:

   ```bash
   cd reef/admin-ui
   bun install        # bun.lock is the tracked lockfile (npm also works)
   bun run dev        # http://localhost:5173
   ```

The Vite dev server proxies `/api/*` → the Reef API (no CORS in dev). Override the
proxy target or add an admin token via a `.env` (see [.env.example](.env.example):
`VITE_REEF_API_TARGET`, `VITE_REEF_ADMIN_TOKEN`).

## What it does

- **Sidebar** — every sandbox on the host (live), each with its **agent-type icon**,
  a status dot, and live CPU. Search + filter by state; a `drift` tag for sandboxes
  Reef didn't create. **New Agent VM** spins one up; the appearance menu lives in
  the footer.
- **Home** (no selection) — the operator command center: KPI tiles, an agent grid,
  and a compact fleet-composition + host-runtime summary.
- **Agent detail** (on selection) — a metrics strip, then tabs:
  - **Overview** — a **Web UI** access panel (URL + password, reveal / copy / open),
    a **Versions** panel (from the agent's volunteered status telemetry), and a
    config card (limits, networking / egress, mounts, **redacted environment**).
  - **Logs** — streaming captured output.
  - Start / stop / destroy (destroy behind a confirm).
- **Create** — a dialog to pick an agent type (OpenClaw, IronClaw, or Hermes),
  name/resources, and optionally wire it to a Clawbits org.
- **Live** — the fleet polls every 5s, health every 10s, logs while a detail is open.

## Layout

| Path | What |
|---|---|
| `src/index.css` | design tokens (clawbits palette + `--brand`) |
| `src/lib/api.ts` | typed API client (mirrors `reef/api/schemas.py`) |
| `src/lib/queries.ts` | TanStack hooks + mutations (fleet / detail / logs / actions / create) |
| `src/lib/fleetStats.ts` | state counts + metric aggregation for the Home KPIs |
| `src/lib/agentTypes.tsx` + `components/agent-icons.tsx` | agent-type registry + OpenClaw / IronClaw / Hermes marks |
| `src/hooks/useTheme.ts` | light / dark / system |
| `src/components/Sidebar.tsx` | the agents sidebar (search, filter, create, appearance) |
| `src/components/Home.tsx` | no-selection fleet home (`KpiTiles`, `AgentGrid`, `FleetComposition`, `HostRuntime`) |
| `src/components/AgentDetail.tsx` | the detail panel (metrics, overview + access + versions, logs) |
| `src/components/CreateSandboxDialog.tsx` · `ConfirmDialog.tsx` | create / destroy dialogs |
| `src/components/ui/*` | button / input / dialog / sidebar primitives |
| `src/App.tsx` | shell: sidebar + main inset, selection + dialog state |
