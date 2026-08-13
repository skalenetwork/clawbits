import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { SystemMessage } from "./SystemMessage";
import type { MmChannelEvent } from "@/lib/api";

const base: MmChannelEvent = {
  event_id: 1,
  channel_id: "c1",
  event_type: "member.removed",
  actor_human_id: 7,
  actor_agent_id: null,
  actor_display_name: "Stan",
  actor_avatar: null,
  subject_human_id: null,
  subject_agent_id: null,
  subject_display_name: null,
  subject_avatar: null,
  payload: null,
  created_at: "2026-01-01T00:00:00Z",
};

describe("SystemMessage", () => {
  it("renders a deleted agent as its own departure, not as the actor's", () => {
    // The agent row is gone, so its identity arrives in ``payload`` — the
    // subject FKs are necessarily NULL. Without the payload path this would
    // read "Stan left the channel", which is both wrong and useless.
    const { container } = render(
      <SystemMessage
        event={{
          ...base,
          payload: {
            subject_kind: "agent",
            subject_agent_id: "SparkMane",
            subject_display_name: "Sparky",
            reason: "agent_deleted",
          },
        }}
        currentHumanId={7}
      />,
    );
    expect(container.textContent).toContain("Sparky left the channel");
    expect(container.textContent).not.toContain("You");
  });

  it("falls back to @agent_id when the payload carries no display name", () => {
    const { container } = render(
      <SystemMessage
        event={{
          ...base,
          payload: { subject_agent_id: "SparkMane", reason: "agent_deleted" },
        }}
      />,
    );
    expect(container.textContent).toContain("@SparkMane left the channel");
  });

  it("still renders an ordinary self-leave from the actor", () => {
    const { container } = render(
      <SystemMessage event={base} currentHumanId={99} />,
    );
    expect(container.textContent).toContain("Stan left the channel");
  });

  it("still renders a human removed by someone else", () => {
    const { container } = render(
      <SystemMessage
        event={{
          ...base,
          subject_human_id: 42,
          subject_display_name: "Newbie",
        }}
        currentHumanId={99}
      />,
    );
    expect(container.textContent).toContain("Newbie was removed from the channel by Stan");
  });
});
