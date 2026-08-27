/** Mattermost channel ids are RFC-4122 v4 UUIDs (8-4-4-4-12 hex). */
export const CLAWBITS_CHANNEL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
