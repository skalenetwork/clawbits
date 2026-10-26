import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ChatScore } from "./ChatScore";
import { MessageComposer, type ComposerHandle } from "@/components/MessageComposer";
import { useScoreLine } from "@/hooks/useWidget";
import { getWidgetScore, type Widget, type WidgetScore } from "@/lib/api";
import { applyWidgetEvent } from "@/lib/widgets";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(),
  getWidgetScore: vi.fn(),
}));

const score = (over: Partial<WidgetScore> = {}): WidgetScore => ({
  channel_id: "c1",
  players: [
    { human_id: 2, agent_id: null, display_name: "Bob", wins: 2 },
    { human_id: 1, agent_id: null, display_name: "Alice", wins: 3 },
  ],
  draws: 1,
  finished: 6,
  ...over,
});

/** Channel info's line, as it reads the chat's score. */
function InfoScore({ enabled = true }: { enabled?: boolean }) {
  const line = useScoreLine("c1", 1, enabled);
  return line ? <ChatScore line={line} /> : null;
}

function withClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

afterEach(() => {
  vi.mocked(getWidgetScore).mockReset();
  vi.unstubAllGlobals();
});

describe("ChatScore", () => {
  it("says the chat's score with the viewer first, and what it is", async () => {
    vi.mocked(getWidgetScore).mockResolvedValue(score());
    render(<InfoScore />, withClient());
    const line = await screen.findByText("You 3 – 2 Bob · 1 draw");
    expect(line.parentElement).toHaveTextContent("Games score: You 3 – 2 Bob · 1 draw");
    expect(getWidgetScore).toHaveBeenCalledWith("c1");
  });

  it("shows nothing before a game in the chat has finished, and asks nothing while it's off", async () => {
    vi.mocked(getWidgetScore).mockResolvedValue(score({ players: [], draws: 0, finished: 0 }));
    const { container } = render(<InfoScore />, withClient());
    await waitFor(() => { expect(getWidgetScore).toHaveBeenCalledOnce(); });
    expect(container).toBeEmptyDOMElement();
    vi.mocked(getWidgetScore).mockClear();
    render(<InfoScore enabled={false} />, withClient());
    expect(getWidgetScore).not.toHaveBeenCalled();
  });

  it("refetches the score when a game in the chat finishes", async () => {
    vi.mocked(getWidgetScore).mockResolvedValueOnce(score({ players: [], draws: 0, finished: 0 }));
    const { client, wrapper } = withClient();
    const { container } = render(<InfoScore />, { wrapper });
    await waitFor(() => { expect(getWidgetScore).toHaveBeenCalledOnce(); });
    expect(container).toBeEmptyDOMElement();
    vi.mocked(getWidgetScore).mockResolvedValueOnce(score({ draws: 0 }));
    const finished = { widget_id: "w1", channel_id: "c1", status: "finished", rev: 9, private: true } as Widget;
    act(() => { applyWidgetEvent(client, finished); });
    expect(await screen.findByText("You 3 – 2 Bob")).toBeInTheDocument();
  });
});

describe("Play a game menu", () => {
  function composer(gameScore: string | null) {
    // The composer asks whether this is a touch device, and watches its own size; the test DOM does neither.
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal("ResizeObserver", class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
    const noop = () => undefined;
    render(
      <MessageComposer
        ref={createRef<ComposerHandle>()}
        isMobile={false}
        wrapperRef={createRef<HTMLDivElement>()}
        orgId={null}
        channelId="c1"
        userId={null}
        channelType="direct"
        members={[]}
        replyingTo={null}
        onCancelReply={noop}
        autoMention={null}
        onDismissAutoMention={noop}
        manualTargetHandle={null}
        onSetManualTarget={noop}
        attachments={[]}
        onAttachmentsAdd={noop}
        onAttachmentRemove={noop}
        isUploading={false}
        isReadyToSend={false}
        uploadedFileIdsCount={0}
        onSubmit={() => Promise.resolve()}
        onStop={null}
        isStopping={false}
        onEditLast={noop}
        isSending={false}
        isChatAtBottom
        onScrollChatToBottom={noop}
        activityPeople={[]}
        agentDm={false}
        onTyping={noop}
        onStartWidget={noop}
        gameScore={gameScore}
      />,
      withClient(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Play a game" }));
  }

  it("heads the games with the chat's score", async () => {
    composer("You 3 – 2 Bob · 1 draw");
    expect(await screen.findByRole("group", { name: "You 3 – 2 Bob · 1 draw" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Chess" })).toBeInTheDocument();
  });

  it("offers the games alone before a game here has finished", async () => {
    composer(null);
    expect(await screen.findByRole("menuitem", { name: "Chess" })).toBeInTheDocument();
    expect(screen.getByRole("group")).not.toHaveAccessibleName();
  });
});
