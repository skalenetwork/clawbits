import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { UserAvatar } from "@/components/UserAvatar";
import type { MmChannelEvent } from "@/lib/api";

/** Centered, non-interactive inline event in the channel timeline.
 *
 *  The "subject" — the person the event is *about* — gets the avatar
 *  chip and bolded name. The actor only shows up as "by …" in the verb
 *  phrase for added/removed events. For join/leave (server emits these
 *  with ``subject = NULL`` when actor == subject) the actor *is* the
 *  subject, so the chip falls back to the actor.
 *
 *  Deliberately spartan compared to ``MessageRow`` — no actions, no
 *  reactions, no threads, no group-start logic. Membership events are
 *  navigational chrome, not content. */
export function SystemMessage({
  event,
  currentHumanId,
}: {
  event: MmChannelEvent;
  /** When provided, the actor or subject matching the viewer is
   *  rendered as "You" instead of their display name — matches the
   *  Slack convention and reads more naturally in one's own feed. */
  currentHumanId?: number | null;
}) {
  const isAdded = event.event_type === "member.added";
  const isRemoved = event.event_type === "member.removed";
  const departed = departedAgent(event);
  const hasSubject =
    departed != null ||
    event.subject_human_id != null ||
    event.subject_agent_id != null;

  const actorIsViewer =
    currentHumanId != null && event.actor_human_id === currentHumanId;
  const subjectIsViewer =
    currentHumanId != null && event.subject_human_id === currentHumanId;

  // For added/removed: the affected person (subject) is the message's
  // primary entity. For join/leave: subject is null and the actor *is*
  // the affected person.
  const primaryIsViewer = departed ? false : hasSubject ? subjectIsViewer : actorIsViewer;
  const primaryName = departed
    ? departed.displayName
    : hasSubject
      ? event.subject_display_name ??
        (event.subject_agent_id ? `@${event.subject_agent_id}` : "Someone")
      : event.actor_display_name ??
        (event.actor_agent_id ? `@${event.actor_agent_id}` : "Someone");
  const primaryLabel = primaryIsViewer ? "You" : primaryName;

  // The actor only surfaces as "by …" when distinct from the subject
  // (added/removed paths). Lowercased so it reads as part of the prose.
  const actorLabel = actorIsViewer
    ? "you"
    : event.actor_display_name ??
      (event.actor_agent_id ? `@${event.actor_agent_id}` : "someone");
  // English subject-verb agreement: viewer takes "were", everyone else
  // takes "was". Singular subjects only (the schema can't express groups).
  const past = primaryIsViewer ? "were" : "was";

  let verbPhrase: string;
  if (departed) {
    // The agent was deleted, not kicked by whoever happens to be the
    // actor — "left the channel" is the honest, low-noise phrasing.
    verbPhrase = "left the channel";
  } else if (isAdded && hasSubject) {
    verbPhrase = `${past} added to the channel by ${actorLabel}`;
  } else if (isAdded) {
    verbPhrase = "joined the channel";
  } else if (isRemoved && hasSubject) {
    verbPhrase = `${past} removed from the channel by ${actorLabel}`;
  } else if (isRemoved) {
    verbPhrase = "left the channel";
  } else {
    // Unknown event type — render a minimal "did something" fallback
    // so the row still occupies its slot and pagination is honest.
    verbPhrase = event.event_type;
  }

  return (
    <div className="mx-auto my-3 flex w-full max-w-chat items-center justify-center px-4">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <PrimaryChip event={event} hasSubject={hasSubject} departed={departed} />
        <span>
          <span className="font-medium text-foreground/80">{primaryLabel}</span>{" "}
          {verbPhrase}
        </span>
      </div>
    </div>
  );
}

/** A ``member.removed`` emitted by agent *deletion*. The agent row is gone
 *  by the time anyone reads the event, so it can't be named through
 *  ``subject_agent_id`` (plain FK — the event would have been deleted with
 *  it); its id and name travel in ``payload`` instead. See
 *  ``TableWrite._emit_agent_departure_events``. Null for every other event. */
function departedAgent(
  event: MmChannelEvent,
): { agentId: string; displayName: string } | null {
  const payload = event.payload;
  if (payload?.reason !== "agent_deleted") return null;
  const agentId =
    typeof payload.subject_agent_id === "string" ? payload.subject_agent_id : null;
  if (!agentId) return null;
  const name =
    typeof payload.subject_display_name === "string"
      ? payload.subject_display_name
      : null;
  return { agentId, displayName: name ?? `@${agentId}` };
}

function PrimaryChip({
  event,
  hasSubject,
  departed,
}: {
  event: MmChannelEvent;
  hasSubject: boolean;
  departed: { agentId: string; displayName: string } | null;
}) {
  const size = 16;
  // Use subject fields when present; otherwise fall back to the actor
  // (join/leave case where actor == subject). A deleted agent has no row
  // left to carry an avatar, so the face falls back to its name.
  const agentId = departed
    ? departed.agentId
    : hasSubject
      ? event.subject_agent_id
      : event.actor_agent_id;
  const humanId = departed
    ? null
    : hasSubject
      ? event.subject_human_id
      : event.actor_human_id;
  const displayName = departed
    ? departed.displayName
    : hasSubject
      ? event.subject_display_name
      : event.actor_display_name;
  const avatarUrl = departed
    ? undefined
    : hasSubject
      ? event.subject_avatar?.url
      : event.actor_avatar?.url;

  if (agentId) {
    return (
      <AgentFaceAvatar size={size} name={displayName ?? agentId} src={avatarUrl}/>
    );
  }
  if (humanId != null) {
    return (
      <UserAvatar size={size} name={displayName ?? String(humanId)} src={avatarUrl}/>
    );
  }
  return null;
}
