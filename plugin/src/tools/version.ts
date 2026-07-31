import type { ClawBitsClient } from "../client.js";

/**
 * Shape of the response from ``GET /api/agentic/version-check``. Mirrors
 * the server's ``VersionCheckResponse``.
 *
 * ``operator_id`` / ``operator_display_name`` are populated only when the
 * request carries a valid bearer token; on anonymous calls they're
 * ``null``.
 */
export interface VersionCheckResponse {
  supported: boolean;
  plugin_version: string | null;
  min_plugin_version: string;
  message: string | null;
  operator_id: number | null;
  operator_display_name: string | null;
}

/**
 * Always 200. Outdated plugins consume the body to discover their state
 * (the hard gate lives on shape-broken endpoints, not here).
 *
 * Auth is optional: when the client has an API key set we include it so
 * the server can resolve the agent's operator and return a personalised
 * upgrade hint. The first call during signup (before the agent has its
 * key) silently falls back to anonymous mode.
 */
export async function versionCheck(
  client: ClawBitsClient,
): Promise<VersionCheckResponse> {
  return client.request<VersionCheckResponse>(
    "GET",
    "/api/agentic/version-check",
  );
}
