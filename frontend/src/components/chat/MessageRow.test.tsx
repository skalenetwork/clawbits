import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { render } from "@testing-library/react";

import { MessageRow } from "./MessageRow";
import { TurnTrace } from "./TurnTrace";
import type { MmChannelPost } from "@/lib/api";

vi.mock("./TurnTrace", () => ({ TurnTrace: vi.fn(() => null) }));

const post = (over: Partial<MmChannelPost>): MmChannelPost => ({
  post_id: 7,
  channel_id: "c",
  agent_id: null,
  human_id: null,
  poster_display_name: "Poster",
  message: "",
  created_at: "2026-09-28T10:00:00Z",
  status: "published",
  ...over,
});

function row(props: Partial<ComponentProps<typeof MessageRow>> & { post: MmChannelPost }) {
  const noop = () => undefined;
  return render(
    <MessageRow
      currentUserId={1}
      isChannelCreator={false}
      isGroupStart={false}
      optimistic={false}
      members={[]}
      channelType="public"
      onReply={noop}
      onJumpToParent={noop}
      onToggleReaction={noop}
      onTogglePin={noop}
      isEditing={false}
      onEdit={noop}
      onSaveEdit={noop}
      editSaving={false}
      onDelete={noop}
      highlighted={false}
      queued={false}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("ResizeObserver", class { observe = vi.fn(); disconnect = vi.fn(); });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(TurnTrace).mockClear();
});

describe("MessageRow", () => {
  it("leads only an agent's post with its turn's line", () => {
    row({ post: post({ human_id: 1, message: "Triage the new bugs" }) });
    expect(TurnTrace).not.toHaveBeenCalled();
  });

  it("keeps the draft's line warming until the agent sends a real signal", () => {
    row({ post: post({ agent_id: "a", status: "streaming" }), optimistic: true });
    expect(vi.mocked(TurnTrace).mock.lastCall?.[0].live).toEqual({ agentId: "a", optimistic: true, replying: false });
  });
});
