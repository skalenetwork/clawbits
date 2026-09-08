// `openclaw/plugin-sdk/skills-runtime` was removed in OpenClaw 2026.8 ("2.0"),
// so it has no published declarations to vendor. skills/sync.ts imports it
// dynamically and degrades when absent; this declares the shape it probes for.
//
// Every other SDK surface is typed from the host's own .d.ts, vendored into
// .sdk by sdk-types.mjs. Do not add modules here to silence an error: an
// ambient `declare module` SHADOWS the real declarations, which is how a
// hand-written approximation can drift from the host without anything failing.

declare module "openclaw/plugin-sdk/skills-runtime" {
  /** Fires on every committed skill create/update/removal, including ones the
   *  agent made itself. Returns an unsubscribe. */
  export function registerSkillsChangeListener(
    listener: (event: { workspaceDir?: string; reason?: string; changedPath?: string }) => void,
  ): () => void;
  export function getSkillsSnapshotVersion(workspaceDir?: string): number;
  /** Force a snapshot refresh after our own write, instead of waiting on the
   *  file watcher. */
  export function bumpSkillsSnapshotVersion(params: {
    workspaceDir?: string;
    reason?: string;
    changedPath?: string;
  }): number;
}
