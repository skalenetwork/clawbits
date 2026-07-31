/**
 * Client-side helpers for the automations UI: starter templates, schedule
 * presets, and the humanizers that turn a stored OpenClaw cron `desired_spec`
 * back into readable rows. A `desired_spec` is the normalized cron create
 * payload (name / schedule / sessionTarget / wakeMode / payload); the server
 * validates and the plugin applies it.
 */
import {
  Megaphone01Icon,
  ChartLineData01Icon,
  Notification03Icon,
  Sun03Icon,
  BinocularsIcon,
  MortarboardIcon,
  Target02Icon,
  CheckmarkCircle02Icon,
  ChefHatIcon,
  Moon02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

import type { AgentLivenessStatus, Automation } from "@/lib/api";
import {
  describeSchedule,
  parseSchedule,
  scheduleToSpec,
  type Schedule,
} from "@/lib/schedule";

export type AutomationAccent = "blue" | "violet" | "teal";

/** Runtimes with NO Clawbits cron reconciler in their in-VM plugin. Only the
 *  OpenClaw plugin reconciles desired-state automations today; a hermes or
 *  ironclaw agent would store rows that sit on "requested" forever. Mirrors
 *  the server's `_AUTOMATION_INCAPABLE_RUNTIMES` gate (which 422s as the hard
 *  boundary — this just keeps the UI honest). */
const AUTOMATION_INCAPABLE_RUNTIMES = new Set(["hermes", "ironclaw"]);

const RUNTIME_LABELS: Record<string, string> = {
  hermes: "Hermes",
  ironclaw: "IronClaw",
};

/** Whether Clawbits-managed automations can actually apply on this agent's
 *  runtime. Null/unknown passes: `agent_type` is self-reported on the first
 *  alive ping and the back-compat default is openclaw. */
export function supportsAutomations(
  agentType: string | null | undefined,
): boolean {
  return !AUTOMATION_INCAPABLE_RUNTIMES.has(agentType ?? "");
}

/** The honest empty-state copy for an automation-incapable runtime, or null
 *  when the runtime is fine. */
export function automationsUnsupportedReason(
  agentType: string | null | undefined,
): string | null {
  if (supportsAutomations(agentType)) return null;
  const label = RUNTIME_LABELS[agentType ?? ""] ?? "this runtime's";
  return `Automations aren't available for ${label} agents yet. Only OpenClaw agents can run them.`;
}

export interface ScheduleUnit {
  id: string;
  label: string;
  ms: number;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Interval units for the "Run every N <unit>" picker. Minutes is the smallest,
 *  which naturally floors any automation at a 1-minute cadence. */
export const SCHEDULE_UNITS: ScheduleUnit[] = [
  { id: "minutes", label: "minutes", ms: MINUTE_MS },
  { id: "hours", label: "hours", ms: HOUR_MS },
  { id: "days", label: "days", ms: DAY_MS },
  { id: "weeks", label: "weeks", ms: WEEK_MS },
];

/** ``everyMs`` for a value + unit, floored at one minute. */
export function intervalToMs(value: number, unitId: string): number {
  const unit = SCHEDULE_UNITS.find(u => u.id === unitId);
  return Math.max(MINUTE_MS, Math.round(value) * (unit?.ms ?? DAY_MS));
}

/** Split an ``everyMs`` back into value + unit, using the largest unit it
 *  divides evenly into (3600000 → 1 hour, 60000 → 1 minute). */
export function decomposeInterval(everyMs: number): {value: number; unitId: string} {
  // Largest unit first (weeks → minutes) so a clean multiple picks the big unit.
  for (const unit of [...SCHEDULE_UNITS].reverse()) {
    if (everyMs % unit.ms === 0) return {value: everyMs / unit.ms, unitId: unit.id};
  }
  return {value: Math.max(1, Math.round(everyMs / MINUTE_MS)), unitId: "minutes"};
}

export interface AutomationTemplate {
  id: string;
  label: string;
  description: string;
  /** Default automation name when the operator picks this template. */
  defaultName: string;
  /** The agentTurn prompt the scheduled run will execute. */
  prompt: string;
  /** Default schedule to pre-fill the composer. Cron presets pin the
   *  operator's local tz at open time (see the Forge) so "9:00" means the
   *  operator's 9:00, never a silent agent-host assumption. */
  defaultSchedule: Schedule;
  /** Shortcuts-style tile glyph (recommendations only). */
  icon?: IconSvgElement;
  /** Tile accent color (recommendations only). */
  accent?: AutomationAccent;
}

/** The suggestion catalog — bigger than the shelf (the UI shows the first 3
 *  not already created, so fresh ideas surface as automations get made).
 *
 *  Ordered by what actually retains users across ChatGPT scheduled tasks,
 *  Claude routines, and the Lindy/Relay/Gumloop galleries (researched
 *  2026-07-02): a personalized daily brief beats everything; monitors survive
 *  only when silent-by-default; learning drills and weekly planning bookends
 *  are the most-loved personal loops; hourly-anything that notifies churns.
 *
 *  Prompts are written for the runtime reality: a cron run is a FRESH,
 *  isolated session — no prior chat, no cross-run memory — so each prompt is
 *  self-contained, personalizes via [bracketed] slots the operator fills in
 *  the Forge, and biases to staying quiet over posting noise. */
export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "morning-briefing",
    label: "Morning briefing",
    description:
      "A short personal brief on the topics you care about, ready when you wake up.",
    defaultName: "Morning briefing",
    prompt:
      "Put together my morning briefing on: [your topics — e.g. AI agents, your industry, your team's stack]. Research what actually changed since yesterday and post 3-5 items that matter, one line each, with links. No filler — if a slot would be padding, drop it. If nothing genuinely new happened, say so in one line.",
    defaultSchedule: { kind: "cron", expr: "0 8 * * *" },
    icon: Sun03Icon,
    accent: "blue",
  },
  {
    id: "topic-watch",
    label: "Topic watch",
    description:
      "Quietly watches something you care about and only speaks when there's news.",
    defaultName: "Topic watch",
    prompt:
      "Check for developments on: [what to watch — a product's releases, a competitor, a price, a niche]. Only consider things published in the last 6 hours. If something noteworthy happened, post a 2-3 line heads-up with a link. Otherwise post nothing at all — silence is the correct output.",
    defaultSchedule: { kind: "every", everyMs: 6 * HOUR_MS },
    icon: BinocularsIcon,
    accent: "teal",
  },
  {
    id: "learning-drill",
    label: "Daily learning drill",
    description: "A five-minute lesson and a short quiz on something you want to master.",
    defaultName: "Daily learning drill",
    prompt:
      "Teach me [what you're learning — a language, a framework, music theory] in one five-minute lesson. Pick one specific concept, explain it with a concrete example, then quiz me with 3 short questions and wait for my answers. Vary the concepts day to day and lean into fundamentals I likely get wrong.",
    defaultSchedule: { kind: "cron", expr: "0 19 * * *" },
    icon: MortarboardIcon,
    accent: "violet",
  },
  {
    id: "monday-plan",
    label: "Monday game plan",
    description: "Starts your week with a short planning ritual you'll actually do.",
    defaultName: "Monday game plan",
    prompt:
      "It's Monday. Post my week-planning ritual: a short template with (1) top 3 priorities this week, (2) anything carried over, (3) one risk to watch. Then ask me one sharp question that helps me commit to priority #1. Keep the whole thing under 10 lines.",
    defaultSchedule: { kind: "cron", expr: "30 8 * * 1" },
    icon: Target02Icon,
    accent: "blue",
  },
  {
    id: "friday-wrapup",
    label: "Friday wrap-up",
    description: "An end-of-week sweep for loose ends before they follow you home.",
    defaultName: "Friday wrap-up",
    prompt:
      "It's Friday afternoon. Post my end-of-week sweep: ask me (1) what shipped this week, (2) what's still open and who's waiting on it, (3) what I'm deliberately NOT doing until Monday. Keep it to three crisp questions — the point is a five-minute ritual, not homework.",
    defaultSchedule: { kind: "cron", expr: "0 16 * * 5" },
    icon: CheckmarkCircle02Icon,
    accent: "violet",
  },
  {
    id: "meal-plan",
    label: "Weekly meal plan",
    description: "A week of dinners plus the grocery list, every Saturday morning.",
    defaultName: "Weekly meal plan",
    prompt:
      "Plan 7 dinners for the coming week. Preferences: [diet, dislikes, cuisines, how much time you have on weeknights]. Keep weeknight recipes under 30 minutes, vary cuisines across the week, then post the plan plus one consolidated grocery list grouped by store section.",
    defaultSchedule: { kind: "cron", expr: "0 10 * * 6" },
    icon: ChefHatIcon,
    accent: "teal",
  },
  {
    id: "evening-journal",
    label: "Evening journal",
    description: "Three reflective questions each night — a journal that asks first.",
    defaultName: "Evening journal",
    prompt:
      "It's the end of my day. Ask me exactly three short reflective questions: one about what went well, one about what was hard, one that's unexpected and makes me think. Vary them every night. Just the questions — no preamble.",
    defaultSchedule: { kind: "cron", expr: "0 21 * * *" },
    icon: Moon02Icon,
    accent: "violet",
  },
  {
    id: "daily-standup",
    label: "Daily standup digest",
    description:
      "Each morning, summarize what changed and post a short standup to its channel.",
    defaultName: "Daily standup digest",
    prompt:
      "Review what happened across your channels since yesterday and post a concise standup digest: what shipped, what's in progress, and anything blocked.",
    defaultSchedule: { kind: "cron", expr: "0 9 * * *" },
    icon: Megaphone01Icon,
    accent: "blue",
  },
  {
    id: "weekly-summary",
    label: "Weekly summary",
    description: "Once a week, compile a recap of the week's activity and highlights.",
    defaultName: "Weekly summary",
    prompt:
      "Compile a summary of this week's activity and key highlights, and post it to your main channel.",
    defaultSchedule: { kind: "cron", expr: "0 9 * * 1" },
    icon: ChartLineData01Icon,
    accent: "violet",
  },
  {
    id: "hourly-check",
    label: "Hourly check-in",
    description: "Every hour, check for anything that needs attention and flag it.",
    defaultName: "Hourly check-in",
    prompt:
      "Check for anything new that needs attention. If something is important, post a brief heads-up; otherwise stay quiet.",
    defaultSchedule: { kind: "every", everyMs: HOUR_MS },
    icon: Notification03Icon,
    accent: "teal",
  },
];

/** "Start from scratch" — not a suggestion; opened from the plain new-automation
 *  affordance, so the create form starts empty. */
export const BLANK_TEMPLATE: AutomationTemplate = {
  id: "blank",
  label: "New automation",
  description: "Write your own prompt and pick a cadence.",
  defaultName: "",
  prompt: "",
  defaultSchedule: { kind: "cron", expr: "0 9 * * *" },
};

/** Build a normalized OpenClaw cron `desired_spec` from the Forge form.
 *
 *  ``channelId`` is the optional delivery target — a channel/DM the agent is in.
 *  When set, the run's output is announced there; when empty/null, ``delivery``
 *  is omitted and the plugin routes to the agent's owner DM (the default). The
 *  operator only authors ``to`` — the plugin fills the runtime channel/account
 *  fields.
 *
 *  ``base`` is the existing spec when editing. PATCH is a FULL REPLACE, so the
 *  base is spread first and only authored fields overwrite it — plugin-owned or
 *  future fields round-trip untouched (dropping them would churn ``spec_hash``
 *  and re-apply the job for nothing). */
export function buildDesiredSpec(input: {
  name: string;
  prompt: string;
  schedule: Schedule;
  channelId?: string | null;
  base?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const base = input.base ?? {};
  const basePayload =
    base.payload && typeof base.payload === "object"
      ? (base.payload as Record<string, unknown>)
      : {};
  const spec: Record<string, unknown> = {
    // Clawbits product defaults — neither has a gateway default, so always set
    // them explicitly (see strategy §3.3). Isolated → fresh session per run.
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    enabled: true,
    ...base,
    name: input.name.trim(),
    schedule: scheduleToSpec(input.schedule),
    payload: { kind: "agentTurn", ...basePayload, message: input.prompt.trim() },
  };
  if (input.channelId) {
    spec.delivery = { mode: "announce", to: input.channelId };
  } else {
    delete spec.delivery;
  }
  // Fields the form doesn't author (description, failureAlert, model, …) ride
  // through the base spread untouched.
  // One-shots disarm after firing; anything recurring must not carry the flag.
  if (input.schedule.kind === "at") spec.deleteAfterRun = true;
  else delete spec.deleteAfterRun;
  return spec;
}

/** The same full spec with only ``enabled`` flipped — the pause/resume payload
 *  (PATCH is full-replace; there is no dedicated toggle endpoint). */
export function withEnabled(
  spec: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> {
  return { ...spec, enabled };
}

/** One human sentence for a stored spec's schedule ("Every day", "At 9:00 AM,
 *  Monday through Friday", "Once on Mon, Jul 6 · 9:00 AM"), or "—". */
export function humanizeSchedule(spec: Record<string, unknown> | null): string {
  return describeSchedule(parseSchedule(spec?.schedule));
}

// ---------------------------------------------------------------------------
// Visual state — the single state language shared by the card, the attention
// shelf, and the detail page (see AUTOMATIONS_UI_PLAN.md "state language").
// Sync failure and run failure are DIFFERENT facts: a sync failure means the
// agent couldn't apply the spec (red, needs attention); a failing run keeps
// the automation active (amber pip + streak) because "green means the run
// didn't crash", not that the task succeeded.
// ---------------------------------------------------------------------------

export type AutomationStateKey =
  | "external"
  | "removing"
  | "failed"
  | "pending"
  | "paused"
  | "running"
  | "active";

export type AutomationDotColor = "emerald" | "amber" | "red" | "blue" | "zinc";

export interface AutomationVisualState {
  key: AutomationStateKey;
  dot: AutomationDotColor;
  /** Chip icon pulses (running / applying-while-agent-online). */
  pulse: boolean;
  /** Label runs the t-shimmer sweep ("Applying…"). */
  shimmer: boolean;
  label: string;
  /** Secondary sentence (sync error text, reconnect note). */
  detail: string | null;
  /** `missing_since` drift — "changed outside Clawbits". */
  drifted: boolean;
  /** Consecutive failing runs (0 when the last run was fine). */
  failStreak: number;
  /** Belongs on the needs-attention shelf. */
  needsAttention: boolean;
}

/** How long after a reported `runningAtMs` we still trust "running now" —
 *  reports arrive once per reconcile cycle, so an old marker is stale, not
 *  evidence of a 20-minute run. */
const RUNNING_FRESH_MS = 10 * 60 * 1000;

function isErrorRunStatus(status: string | undefined | null): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "error" || s === "failed" || s === "failure";
}

export function automationVisualState(
  a: Automation,
  agentStatus: AgentLivenessStatus,
  agentName: string,
  now: number = Date.now(),
): AutomationVisualState {
  const state = a.reported_state;
  const drifted = a.missing_since != null;
  const lastRunFailed = isErrorRunStatus(state?.lastRunStatus);
  const failStreak = lastRunFailed ? Math.max(1, state?.consecutiveErrors ?? 1) : 0;
  const common = { drifted, failStreak };

  if (a.managed_by === "external") {
    return {
      key: "external",
      dot: "zinc",
      pulse: false,
      shimmer: false,
      label: "Mirror",
      detail: "Managed outside Clawbits",
      ...common,
      needsAttention: false,
    };
  }
  if (a.sync_status === "removing") {
    return {
      key: "removing",
      dot: "zinc",
      pulse: false,
      shimmer: true,
      label: "Removing…",
      detail: null,
      ...common,
      needsAttention: false,
    };
  }
  if (a.sync_status === "failed") {
    return {
      key: "failed",
      dot: "red",
      pulse: false,
      shimmer: false,
      label: "Sync failed",
      detail: a.sync_error,
      ...common,
      needsAttention: true,
    };
  }
  if (a.sync_status === "requested") {
    const offline = agentStatus !== "available";
    return {
      key: "pending",
      dot: "amber",
      pulse: !offline,
      shimmer: !offline,
      label: offline ? "Pending" : "Applying…",
      detail: offline ? `Will apply when ${agentName} reconnects` : null,
      ...common,
      // Pending-on-offline is a waiting state, not a broken one — the card and
      // the agent group header carry it; the attention shelf is for failures
      // and drift only.
      needsAttention: false,
    };
  }
  if (a.enabled === false) {
    return {
      key: "paused",
      dot: "zinc",
      pulse: false,
      shimmer: false,
      label: "Paused",
      detail: "Keeps its configuration",
      ...common,
      // Drift is drift even while sleeping — the live job disagrees with the
      // stored intent, so the shelf should still surface it.
      needsAttention: drifted,
    };
  }
  const runningAt = state?.runningAtMs;
  const lastRunAt = state?.lastRunAtMs;
  if (
    typeof runningAt === "number" &&
    now - runningAt < RUNNING_FRESH_MS &&
    (typeof lastRunAt !== "number" || lastRunAt < runningAt)
  ) {
    return {
      key: "running",
      dot: "blue",
      pulse: true,
      shimmer: false,
      label: "Running now",
      detail: null,
      ...common,
      needsAttention: drifted,
    };
  }
  return {
    key: "active",
    dot: "emerald",
    pulse: false,
    shimmer: false,
    label: "Active",
    detail: null,
    ...common,
    needsAttention: drifted,
  };
}

// ---------------------------------------------------------------------------
// Accent tiles — the saturated Shortcuts-style register the automations UI
// owns. Ad-hoc automations pick deterministically from the palette by id so a
// card keeps its face across reloads.
// ---------------------------------------------------------------------------

/** Solid tile fills (white content) — readable in both modes. */
export const ACCENT_BG: Record<AutomationAccent, string> = {
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  teal: "bg-teal-500",
};

const ACCENT_ORDER: AutomationAccent[] = ["blue", "violet", "teal"];

/** Route to an automation's detail page. Pass ``scopeAgentId`` when
 *  navigating FROM an agent's Automations tab so the user stays in the agent
 *  context (same sidebar + breadcrumbs); the bare path is the org mount. */
export function automationDetailPath(a: Automation, scopeAgentId?: string): string {
  const id = encodeURIComponent(a.automation_id);
  return scopeAgentId
    ? `/agents/${encodeURIComponent(scopeAgentId)}/automations/${id}`
    : `/automations/${id}`;
}

/** Stable accent for an automation without a template accent. */
export function accentForId(id: string): AutomationAccent {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return ACCENT_ORDER[Math.abs(hash) % ACCENT_ORDER.length] ?? "blue";
}
