import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentUser } from "@/lib/api";
import { HOME_DRAFT_KEY, draftStore } from "@/lib/messageDrafts";

// jsdom has no matchMedia; the composer asks it whether this is a touch device.
vi.stubGlobal("matchMedia", () => ({ matches: false }));

vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { id: 7 } }) }));

const navigate = vi.fn();
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));

const createMmAgentChat = vi.fn();
const createOrGetMmDirect = vi.fn();
const createMmChannelPost = vi.fn();
const setAgentModel = vi.fn();
vi.mock("@/lib/api", () => ({
  createMmAgentChat: (...args: unknown[]) => createMmAgentChat(...args) as Promise<unknown>,
  createOrGetMmDirect: (...args: unknown[]) => createOrGetMmDirect(...args) as Promise<unknown>,
  createMmChannelPost: (...args: unknown[]) => createMmChannelPost(...args) as Promise<unknown>,
  setAgentModel: (...args: unknown[]) => setAgentModel(...args) as Promise<unknown>,
  getAgentModels: () => Promise.resolve({ models: null, runtime_default: null, default: {}, reported_at: null }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

const { HomeComposer } = await import("./HomeComposer");

const AGENTS: AgentUser[] = [
  { agent_id: "clawd", display_name: "Clawd", can_dm: true },
  { agent_id: "finny", display_name: "Finny", can_dm: true },
];

function mount(agents = AGENTS) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HomeComposer orgId="org-1" agents={agents}/>
    </QueryClientProvider>,
  );
}

function composer(): HTMLTextAreaElement {
  return screen.getByLabelText("Start a chat");
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  draftStore.clear(7, HOME_DRAFT_KEY);
  draftStore.flush();
  createMmAgentChat.mockResolvedValue({ channel_id: "ch-new" });
  createOrGetMmDirect.mockResolvedValue({ channel_id: "ch-dm" });
  createMmChannelPost.mockResolvedValue({ post_id: 1 });
});

describe("HomeComposer", () => {
  it("opens on the first ranked agent and starts a session on Enter", async () => {
    mount();
    expect(composer().placeholder).toBe("What should Clawd work on?");

    fireEvent.change(composer(), { target: { value: "ship it" } });
    fireEvent.keyDown(composer(), { key: "Enter" });

    await waitFor(() => { expect(navigate).toHaveBeenCalledWith("/channels/ch-new"); });
    expect(createMmAgentChat).toHaveBeenCalledWith("org-1", "clawd");
    expect(createMmChannelPost).toHaveBeenCalledWith("ch-new", "ship it");
    // Nothing was picked, so the agent's own default is left alone.
    expect(setAgentModel).not.toHaveBeenCalled();
    expect(composer().value).toBe("");
  });

  it("keeps the message on a newline and sends nothing empty", () => {
    mount();
    fireEvent.keyDown(composer(), { key: "Enter", shiftKey: true });
    fireEvent.change(composer(), { target: { value: "   " } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(createMmAgentChat).not.toHaveBeenCalled();
  });

  it("cycles the target agent on mod+shift+J", () => {
    mount();
    fireEvent.keyDown(composer(), { key: "J", metaKey: true, shiftKey: true });
    expect(composer().placeholder).toBe("What should Finny work on?");
    fireEvent.keyDown(composer(), { key: "J", metaKey: true, shiftKey: true });
    expect(composer().placeholder).toBe("What should Clawd work on?");
  });

  it("restores the draft and the agent it was aimed at", () => {
    draftStore.set(7, HOME_DRAFT_KEY, { text: "half written", reply: null, targetAgentId: "finny" });
    mount();
    expect(composer().value).toBe("half written");
    expect(composer().placeholder).toBe("What should Finny work on?");
  });

  it("keeps the text when starting the chat fails", async () => {
    createMmAgentChat.mockRejectedValue(new Error("nope"));
    mount();
    fireEvent.change(composer(), { target: { value: "ship it" } });
    fireEvent.keyDown(composer(), { key: "Enter" });

    await waitFor(() => { expect(createMmAgentChat).toHaveBeenCalled(); });
    expect(navigate).not.toHaveBeenCalled();
    expect(composer().value).toBe("ship it");
  });

  it("takes a letter typed anywhere, and leaves bare digits to the tiles", () => {
    mount();
    expect(document.activeElement).not.toBe(composer());

    fireEvent.keyDown(document.body, { key: "2" });
    expect(document.activeElement).not.toBe(composer());

    fireEvent.keyDown(document.body, { key: "h" });
    expect(document.activeElement).toBe(composer());
  });

  it("hands the keyboard back to the tiles on Escape", () => {
    mount();
    fireEvent.keyDown(document.body, { key: "h" });
    expect(document.activeElement).toBe(composer());

    fireEvent.keyDown(composer(), { key: "Escape" });
    expect(document.activeElement).not.toBe(composer());
  });

  it("renders nothing when no agent can be contacted", () => {
    const { container } = mount([]);
    expect(container).toBeEmptyDOMElement();
  });
});
