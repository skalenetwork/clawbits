import type {MmSearchFilters} from "@/lib/api";

export const queryKeys = {
  /** Caller's per-signal privacy flags (last seen, online status, read
   *  receipts, typing). One global entry — the row belongs to the
   *  authenticated user. */
  privacySettings: ["privacy", "settings"] as const,
  /** Third-party identity connectors (GitHub, Notion, …). */
  connectors: ["connectors"] as const,
  orgs: ["orgs"] as const,
  org: (orgId: string) => ["org", orgId] as const,
  orgMembers: (orgId: string) => ["org", orgId, "members"] as const,
  orgChannels: (orgId: string) => ["org", orgId, "channels"] as const,
  agents: (orgId: string) => ["agents", orgId] as const,
  /** One agent's profile — shared by the agent card + every agent subpage
   *  (inbox / automations / manage) and their invalidators. Spell it here so a
   *  typo can't silently break invalidation across the ~handful of call sites. */
  agentProfile: (orgId: string, agentId: string) =>
    ["agentProfile", orgId, agentId] as const,
  /** Org-wide AI-usage dashboard (per range + grouping). */
  orgUsage: (orgId: string, range: string, groupBy: string) =>
    ["org", orgId, "usage", range, groupBy] as const,
  /** One agent's AI usage. */
  agentUsage: (orgId: string, agentId: string, range: string) =>
    ["org", orgId, "usage", "agent", agentId, range] as const,
  /** Prefix covering every automation query in an org, for invalidation. */
  automations: (orgId: string) => ["automations", orgId] as const,
  /** One agent's automation list. */
  automationsForAgent: (orgId: string, agentId: string) =>
    ["automations", orgId, "agent", agentId] as const,
  /** Run history for one automation. */
  automationRuns: (orgId: string, agentId: string, automationId: string) =>
    ["automations", orgId, agentId, automationId, "runs"] as const,
  /** The org's skill library. Shares a prefix with the per-skill keys so one
   *  invalidateQueries({queryKey: queryKeys.skills(orgId)}) refreshes the list,
   *  every detail, and every version timeline — the automations discipline. */
  skills: (orgId: string) => ["skills", orgId] as const,
  /** One skill (with its current version's content). */
  skill: (orgId: string, skillId: string) => ["skills", orgId, skillId] as const,
  /** One skill's version timeline. */
  skillVersions: (orgId: string, skillId: string) =>
    ["skills", orgId, skillId, "versions"] as const,
  /** The rendered SKILL.md for one version on one runtime. */
  skillRender: (orgId: string, skillId: string, versionId: string, runtime: string) =>
    ["skills", orgId, skillId, versionId, "render", runtime] as const,
  /** Skills one agent reported as present on disk. */
  agentSkills: (orgId: string, agentId: string) =>
    ["skills", orgId, "agent", agentId] as const,
  /** Channels/DMs an agent is in — the automation delivery-target picker. */
  agentChannels: (orgId: string, agentId: string) =>
    ["agentChannels", orgId, agentId] as const,
  agentModels: (orgId: string, agentId: string) =>
    ["agentModels", orgId, agentId] as const,
  /** An agent's contact allowlist — who may DM / @-tag it (Manage page). */
  agentContactPermissions: (agentId: string) =>
    ["agentContactPermissions", agentId] as const,
  orgSignupRequests: (orgId: string) => ["org", orgId, "signup-requests"] as const,
  /** The org's LobsterTalk attention config (toggle + mode + LLM connection). */
  orgLobstertalk: (orgId: string) => ["org", orgId, "lobstertalk"] as const,
  /** The org's reef repository, plus the hosts reporting into it. */
  reef: (orgId: string) => ["org", orgId, "reef"] as const,
  /** The role catalog in the org's reef repository. */
  reefRoles: (orgId: string) => ["org", orgId, "reef", "roles"] as const,
  /** Operator-only agent email inbox (Stalwart). */
  agentInbox: {
    count: (orgId: string, agentId: string) =>
      ["agent-inbox", orgId, agentId, "count"] as const,
    list: (orgId: string, agentId: string, limit: number) =>
      ["agent-inbox", orgId, agentId, "list", limit] as const,
    /** Prefix matching every list limit, for invalidation: refreshes the list
     *  without touching the open message (which would re-fetch and re-mark-read
     *  in a loop). */
    listPrefix: (orgId: string, agentId: string) =>
      ["agent-inbox", orgId, agentId, "list"] as const,
    email: (orgId: string, agentId: string, uid: number) =>
      ["agent-inbox", orgId, agentId, "email", uid] as const,
  },
  mm: {
    /** Org-scoped channel list. Pass `null` only when there's no active org. */
    channels: (orgId: string | null) => ["mm", "channels", orgId] as const,
    /** Prefix used to invalidate every org's channel cache at once. */
    channelsAll: ["mm", "channels"] as const,
    /** Org-scoped discoverable channels — public channels the viewer
     *  isn't a member of yet. Drives the join-channel browser AND the
     *  ``#channel`` autocomplete's "not joined" suggestions. */
    discoverableChannels: (orgId: string | null) =>
      ["mm", "discoverable-channels", orgId] as const,
    channel: (channelId: string) => ["mm", "channel", channelId] as const,
    channelPosts: (channelId: string, limit?: number, offset?: number) =>
      ["mm", "channel", channelId, "posts", { limit, offset }] as const,
    /** Inline channel-timeline events (member.added / member.removed
     *  today). Held in a separate cache from posts so the post pipeline
     *  is unaffected; the channel view merges both at render time. */
    channelEvents: (channelId: string, limit?: number) =>
      ["mm", "channel", channelId, "events", { limit }] as const,
    channelMembers: (channelId: string) =>
      ["mm", "channel", channelId, "members"] as const,
    channelPinnedPosts: (channelId: string) =>
      ["mm", "channel", channelId, "pinned-posts"] as const,
    linkPreview: (url: string) => ["mm", "link-preview", url] as const,
    search: (orgId: string | null, query: string, sort: string, filters: MmSearchFilters) =>
      ["mm", "search", orgId, query, sort, filters] as const,
  },
} as const;
