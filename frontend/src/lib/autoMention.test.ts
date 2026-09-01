import { describe, it, expect } from "vitest";
import { computePendingAutoMention, type ComputePendingAutoMentionInput } from "@/lib/autoMention";
import type { MmChannelMember, MmChannelPost } from "@/lib/api";

const ME = 42;
const WINDOW_MS = 5 * 60_000;
const NOW = Date.parse("2026-05-14T12:00:00Z");

function member(overrides: Partial<MmChannelMember>): MmChannelMember {
  return {
    agent_id: null,
    human_id: null,
    display_name: null,
    status: "online",
    last_seen_at: null,
    ...overrides,
  } as MmChannelMember;
}

function post(overrides: Partial<MmChannelPost>): MmChannelPost {
  return {
    post_id: 1,
    channel_id: "ch",
    agent_id: null,
    human_id: null,
    poster_display_name: null,
    message: "",
    created_at: new Date(NOW - 30_000).toISOString(),
    status: "published",
    parent_post_id: null,
    ...overrides,
  };
}

const handleFor = (m: MmChannelMember) =>
  m.agent_id ?? (m.human_id != null ? `user-${String(m.human_id)}` : "x");
const labelFor = (m: MmChannelMember) =>
  m.display_name ?? m.agent_id ?? (m.human_id != null ? `User ${String(m.human_id)}` : "Unknown");

function base(over: Partial<ComputePendingAutoMentionInput> = {}): ComputePendingAutoMentionInput {
  return {
    currentUserId: ME,
    isDirectChannel: false,
    members: [
      member({ human_id: ME, display_name: "Alice" }),
      member({ agent_id: "bot" }),
    ],
    posts: [],
    replyingTo: null,
    handleFor, labelFor,
    myMentionTokens: new Set(["user-42", "alice"]),
    nowMs: NOW,
    windowMs: WINDOW_MS,
    // Default: viewer entered the channel a minute before NOW, so all
    // sub-1-minute-old posts in existing tests are still "active turn".
    channelEnteredAtMs: NOW - 60_000,
    ...over,
  };
}

describe("computePendingAutoMention", () => {
  it("returns null in a direct channel — server-side auto-reply covers it", () => {
    expect(computePendingAutoMention(base({ isDirectChannel: true }))).toBeNull();
  });

  it("returns null when no agent is a member of the channel", () => {
    const res = computePendingAutoMention(
      base({ members: [member({ human_id: ME, display_name: "Alice" })] }),
    );
    expect(res).toBeNull();
  });

  it("(1) fires on Reply to an agent post — always wins", () => {
    const agentPost = post({ post_id: 99, agent_id: "bot", message: "hello" });
    const res = computePendingAutoMention(base({ replyingTo: agentPost }));
    expect(res).toMatchObject({ agentId: "bot", reason: "reply", triggerKey: "reply:99" });
  });

  it("(1) ignores Reply when the post isn't an agent's", () => {
    const humanPost = post({ post_id: 99, human_id: ME, message: "hi" });
    const res = computePendingAutoMention(base({ replyingTo: humanPost }));
    expect(res).toBeNull();
  });

  it("(2) fires when the agent's last post @-mentions me", () => {
    const res = computePendingAutoMention(base({
      posts: [post({ post_id: 10, agent_id: "bot", message: "Sure @alice, here goes" })],
    }));
    expect(res).toMatchObject({ agentId: "bot", reason: "agent-to-me", triggerKey: "a2m:10" });
  });

  it("(2) fires when the agent's last post is a reply to one of mine", () => {
    const res = computePendingAutoMention(base({
      posts: [
        post({ post_id: 11, agent_id: "bot", parent_post_id: 7, message: "yep" }),
        post({ post_id: 7,  human_id: ME, message: "do this thing" }),
      ],
    }));
    expect(res?.reason).toBe("agent-to-me");
    expect(res?.triggerKey).toBe("a2m:11");
  });

  it("(2) does NOT fire when the agent's last post was to someone else", () => {
    const res = computePendingAutoMention(base({
      posts: [
        post({ post_id: 11, agent_id: "bot", message: "thanks bob" }),
        post({ post_id: 7,  human_id: 99, message: "agent help me" }),
      ],
    }));
    expect(res).toBeNull();
  });

  it("(3) fires when my last post @-mentioned an agent", () => {
    const res = computePendingAutoMention(base({
      posts: [post({ post_id: 20, human_id: ME, message: "hey @bot, status?" })],
    }));
    expect(res).toMatchObject({ agentId: "bot", reason: "me-to-agent", triggerKey: "m2a:20" });
  });

  it("(3) does NOT fire when my last post only mentioned humans", () => {
    const res = computePendingAutoMention(base({
      posts: [post({ post_id: 20, human_id: ME, message: "hi @someone" })],
    }));
    expect(res).toBeNull();
  });

  it("expires after the 5-minute window", () => {
    const stale = post({
      post_id: 30, agent_id: "bot", message: "hi @alice",
      created_at: new Date(NOW - (WINDOW_MS + 1000)).toISOString(),
    });
    expect(computePendingAutoMention(base({ posts: [stale] }))).toBeNull();
  });

  it("suppresses time-based triggers when the post predates channel entry", () => {
    // Opened the channel just now. An agent had replied to me 2 minutes
    // before I arrived — I'm catching up on history, not mid-turn.
    const justEntered = NOW;
    const oldAgentPost = post({
      post_id: 70, agent_id: "bot", message: "ack @alice",
      created_at: new Date(NOW - 2 * 60_000).toISOString(),
    });
    const res = computePendingAutoMention(base({
      posts: [oldAgentPost],
      channelEnteredAtMs: justEntered,
    }));
    expect(res).toBeNull();
  });

  it("fires for posts arriving AFTER I entered the channel", () => {
    // Same agent post, but it landed 30 s after I joined.
    const enteredEarlier = NOW - 60_000;
    const freshAgentPost = post({
      post_id: 71, agent_id: "bot", message: "yo @alice",
      created_at: new Date(NOW - 30_000).toISOString(),
    });
    const res = computePendingAutoMention(base({
      posts: [freshAgentPost],
      channelEnteredAtMs: enteredEarlier,
    }));
    expect(res?.reason).toBe("agent-to-me");
    expect(res?.triggerKey).toBe("a2m:71");
  });

  it("Reply trigger bypasses the channel-entry floor (explicit intent)", () => {
    // Even right after opening the channel, hitting Reply on an old
    // agent post should still pre-fill the chip — it's user intent.
    const justEntered = NOW;
    const oldAgentPost = post({
      post_id: 80, agent_id: "bot",
      created_at: new Date(NOW - 24 * 60 * 60_000).toISOString(),
    });
    const res = computePendingAutoMention(base({
      replyingTo: oldAgentPost,
      channelEnteredAtMs: justEntered,
    }));
    expect(res?.reason).toBe("reply");
    expect(res?.triggerKey).toBe("reply:80");
  });

  it("treats SQLite naive datetime strings as UTC (not browser-local)", () => {
    // The server returns "2026-05-14 12:00:00" without a Z; ``Date.parse``
    // would default to local time and the timezone offset would push the
    // post out of the 5-min window in any non-UTC environment. The fix
    // treats this shape as UTC explicitly.
    const utcNaive = "2026-05-14 12:00:00"; // == NOW
    const res = computePendingAutoMention(base({
      posts: [post({ post_id: 60, human_id: ME, message: "hey @bot", created_at: utcNaive })],
    }));
    expect(res?.reason).toBe("me-to-agent");
    expect(res?.triggerKey).toBe("m2a:60");
  });

  it("skips other authors' drafts when picking the newest", () => {
    // A draft from another author isn't visible in the feed, so it
    // shouldn't influence the chip. Fall through to the published
    // agent-to-me post.
    const res = computePendingAutoMention(base({
      posts: [
        post({ post_id: 41, agent_id: "scout", status: "draft", message: "shh" }),
        post({ post_id: 40, agent_id: "bot", message: "yep @alice" }),
      ],
      members: [
        member({ human_id: ME, display_name: "Alice" }),
        member({ agent_id: "bot" }),
        member({ agent_id: "scout" }),
      ],
    }));
    expect(res).toMatchObject({ agentId: "bot", reason: "agent-to-me", triggerKey: "a2m:40" });
  });

  it("(3) fires on my own draft @-mentioning an agent — approval-gated mention", () => {
    // When the agent has require_response_approval=true, the server
    // creates the human's post as `status="draft"`. The user still sees
    // it in their feed and expects the chip to reflect their intent.
    const res = computePendingAutoMention(base({
      posts: [
        post({ post_id: 50, human_id: ME, status: "draft", message: "hey @bot" }),
      ],
    }));
    expect(res).toMatchObject({ agentId: "bot", reason: "me-to-agent", triggerKey: "m2a:50" });
  });

  it("disambiguates multi-agent channels by picking the agent in the trigger", () => {
    const res = computePendingAutoMention(base({
      members: [
        member({ human_id: ME, display_name: "Alice" }),
        member({ agent_id: "bot" }),
        member({ agent_id: "scout" }),
      ],
      posts: [post({ post_id: 50, agent_id: "scout", message: "ack @alice" })],
    }));
    expect(res?.agentId).toBe("scout");
  });

  it("Reply trigger beats time-based ones", () => {
    const res = computePendingAutoMention(base({
      replyingTo: post({ post_id: 100, agent_id: "scout" }),
      members: [
        member({ human_id: ME, display_name: "Alice" }),
        member({ agent_id: "bot" }),
        member({ agent_id: "scout" }),
      ],
      posts: [post({ post_id: 60, agent_id: "bot", message: "hey @alice" })],
    }));
    expect(res?.agentId).toBe("scout");
    expect(res?.reason).toBe("reply");
  });

  // ----- Stickiness through agent continuation replies ---------------------

  it("latches the prior me-to-agent turn when the agent's newest reply doesn't address me", () => {
    // I asked @bot something; bot then posted a "still working" message
    // that neither replies to me nor @-mentions me. The chip should
    // stay on @bot via the previous m2a trigger.
    const res = computePendingAutoMention(base({
      posts: [
        post({ post_id: 31, agent_id: "bot", message: "still working on it" }),
        post({ post_id: 30, human_id: ME, message: "hey @bot, status?" }),
      ],
    }));
    expect(res).toMatchObject({
      agentId: "bot",
      reason: "me-to-agent",
      triggerKey: "m2a:30",
    });
  });

  it("latches a prior agent-to-me turn through another agent's non-addressing post", () => {
    // bot @-mentioned me; later scout posted something to nobody. The
    // chip should remain on bot (the agent who last addressed me).
    const res = computePendingAutoMention(base({
      members: [
        member({ human_id: ME, display_name: "Alice" }),
        member({ agent_id: "bot" }),
        member({ agent_id: "scout" }),
      ],
      posts: [
        post({ post_id: 41, agent_id: "scout", message: "logging this" }),
        post({ post_id: 40, agent_id: "bot", message: "ack @alice" }),
      ],
    }));
    expect(res).toMatchObject({
      agentId: "bot",
      reason: "agent-to-me",
      triggerKey: "a2m:40",
    });
  });

  it("the fallback respects the 5-minute window — stale prior trigger doesn't latch", () => {
    const res = computePendingAutoMention(base({
      posts: [
        post({
          post_id: 51, agent_id: "bot", message: "still on it",
          created_at: new Date(NOW - 30_000).toISOString(),
        }),
        post({
          post_id: 50, human_id: ME, message: "hey @bot",
          created_at: new Date(NOW - (WINDOW_MS + 1000)).toISOString(),
        }),
      ],
    }));
    expect(res).toBeNull();
  });

  it("the fallback respects the channel-entry floor — pre-history doesn't latch", () => {
    // I just opened the channel. There's a fresh agent post that
    // doesn't address me, and a (pre-entry) m2a in history. The
    // fallback must not resurrect history.
    const justEntered = NOW - 10_000;
    const res = computePendingAutoMention(base({
      channelEnteredAtMs: justEntered,
      posts: [
        post({
          post_id: 61, agent_id: "bot", message: "fyi",
          created_at: new Date(NOW - 5_000).toISOString(),
        }),
        post({
          post_id: 60, human_id: ME, message: "hey @bot",
          created_at: new Date(NOW - 2 * 60_000).toISOString(),
        }),
      ],
    }));
    expect(res).toBeNull();
  });

  it("the fallback picks the most recent qualifying post, not the oldest", () => {
    // Newest is bot's non-addressing reply. Walking back: scout @-mentioned
    // me 30s ago (a2m), my @bot is 90s ago (m2a). The newer one wins.
    const res = computePendingAutoMention(base({
      members: [
        member({ human_id: ME, display_name: "Alice" }),
        member({ agent_id: "bot" }),
        member({ agent_id: "scout" }),
      ],
      posts: [
        post({
          post_id: 73, agent_id: "bot", message: "thinking…",
          created_at: new Date(NOW - 5_000).toISOString(),
        }),
        post({
          post_id: 72, agent_id: "scout", message: "got it @alice",
          created_at: new Date(NOW - 30_000).toISOString(),
        }),
        post({
          post_id: 71, human_id: ME, message: "hey @bot",
          created_at: new Date(NOW - 90_000).toISOString(),
        }),
      ],
    }));
    expect(res).toMatchObject({
      agentId: "scout",
      reason: "agent-to-me",
      triggerKey: "a2m:72",
    });
  });

  it("the fallback returns a stable triggerKey across consecutive agent non-addressing posts", () => {
    // Dismissal is keyed on triggerKey — if the fallback returned a
    // different key for each new agent post, the user's dismiss would
    // be undone every time the agent typed again. Verify the latched
    // key stays pinned to the underlying user turn.
    const myPost = post({ post_id: 80, human_id: ME, message: "hey @bot" });
    const first = computePendingAutoMention(base({
      posts: [
        post({ post_id: 81, agent_id: "bot", message: "ok" }),
        myPost,
      ],
    }));
    const second = computePendingAutoMention(base({
      posts: [
        post({ post_id: 82, agent_id: "bot", message: "still working" }),
        post({ post_id: 81, agent_id: "bot", message: "ok" }),
        myPost,
      ],
    }));
    expect(first?.triggerKey).toBe("m2a:80");
    expect(second?.triggerKey).toBe("m2a:80");
  });

  it("does NOT latch when my newest post is non-addressing — moved-on signal clears chip", () => {
    // Prior turn was @bot. Then I posted "thanks @alice" with no agent
    // mention. That's a deliberate "moved on" signal: chip clears.
    const res = computePendingAutoMention(base({
      posts: [
        post({ post_id: 91, human_id: ME, message: "thanks @alice" }),
        post({ post_id: 90, human_id: ME, message: "hey @bot" }),
      ],
    }));
    expect(res).toBeNull();
  });

  it("does NOT latch when another human's post is newest — fallback only fires for agent posts", () => {
    // Bob chimes in after my @bot turn. Current behaviour preserved:
    // chip clears (the user explicitly chose to scope stickiness to
    // agent replies only).
    const res = computePendingAutoMention(base({
      posts: [
        post({ post_id: 101, human_id: 99, message: "yo" }),
        post({ post_id: 100, human_id: ME, message: "hey @bot" }),
      ],
    }));
    expect(res).toBeNull();
  });
});
