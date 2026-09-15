import {beforeEach, describe, expect, it, vi} from "vitest";
import {fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {MmAdminChannel, OrgLobstertalkSettings, SetOrgLobstertalkBody} from "@/lib/api";

// Mutable so a test can simulate the user switching orgs mid-save (the page
// re-renders with a new activeOrgId while a mutation is still in flight).
const auth = {activeOrgId: "org-1"};
vi.mock("@/context/AuthContext", () => ({
    useAuth: () => ({activeOrgId: auth.activeOrgId}),
}));

vi.mock("@/hooks/useActiveOrg", () => ({
    useActiveOrg: () => ({isOwner: true, isLoading: false}),
}));

const getOrgLobstertalk = vi.fn();
const setOrgLobstertalk = vi.fn();
const checkOrgLobstertalkEndpoint = vi.fn();
const listAllOrgChannels = vi.fn();
const setOrgLobstertalkChannel = vi.fn();
vi.mock("@/lib/api", () => ({
    getOrgLobstertalk: (orgId: string) => getOrgLobstertalk(orgId) as Promise<OrgLobstertalkSettings>,
    setOrgLobstertalk: (orgId: string, body: SetOrgLobstertalkBody) =>
        setOrgLobstertalk(orgId, body) as Promise<OrgLobstertalkSettings>,
    checkOrgLobstertalkEndpoint: (orgId: string) =>
        checkOrgLobstertalkEndpoint(orgId) as Promise<unknown>,
    listAllOrgChannels: (orgId: string) =>
        listAllOrgChannels(orgId) as Promise<{channels: MmAdminChannel[]; total: number}>,
    setOrgLobstertalkChannel: (orgId: string, channelId: string, approved: boolean) =>
        setOrgLobstertalkChannel(orgId, channelId, approved) as Promise<unknown>,
}));

const toastSuccess = vi.fn();
vi.mock("@/lib/toast", () => ({
    toast: {
        success: (...args: unknown[]) => { toastSuccess(...args); },
        error: vi.fn(),
    },
    errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

const {default: SettingsLobstertalkPage} = await import("./SettingsLobstertalkPage");

/** Saved config with the gate armed or disarmed. Cascade by default, so a
 *  leaked triage form would show both the mode picker and the LLM fields. */
function settings(
    enabled: boolean,
    mode: OrgLobstertalkSettings["mode"] = "cascade",
): OrgLobstertalkSettings {
    return {
        enabled,
        mode,
        base_url: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        api_key_set: true,
        cooldown_seconds: null,
        default_cooldown_seconds: 30,
    };
}

/** A row as the admin channels list returns it: unapproved public by
 *  default, the post-migration state of every channel. */
function adminChannel(
    over: Partial<MmAdminChannel> & {channel_id: string; name: string},
): MmAdminChannel {
    return {
        org_id: "org-1",
        display_name: null,
        channel_type: "public",
        created_at: "2026-08-01T00:00:00Z",
        member_count: 1,
        lobstertalk_approved: false,
        ...over,
    };
}

const masterSwitch = () => screen.findByRole("switch", {name: "LobsterTalk attention"});
const modePicker = () => screen.getByRole("combobox", {name: "Triage mode"});
const cooldown = () => screen.getByRole("group", {name: "Nudge cooldown in seconds"});

// Base UI only commits a mouse click that started on the item, so the
// pointerdown a real click produces has to come first.
async function pickMode(name: string) {
    fireEvent.click(modePicker());
    const option = await screen.findByRole("option", {name});
    fireEvent.pointerDown(option);
    fireEvent.click(option);
}

async function renderPage(
    enabled: boolean,
    mode?: OrgLobstertalkSettings["mode"],
    over: Partial<OrgLobstertalkSettings> = {},
) {
    getOrgLobstertalk.mockResolvedValue({...settings(enabled, mode), ...over});
    // Retries would stall the test on an unexpected rejection.
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    render(
        <QueryClientProvider client={client}>
            <SettingsLobstertalkPage/>
        </QueryClientProvider>,
    );
    // The master switch renders in the same pass as the triage section, so
    // awaiting it means an absent picker is really absent, not just pending.
    await masterSwitch();
}

describe("SettingsLobstertalkPage", () => {
    beforeEach(() => {
        auth.activeOrgId = "org-1";
        getOrgLobstertalk.mockReset();
        setOrgLobstertalk.mockReset();
        toastSuccess.mockReset();
        checkOrgLobstertalkEndpoint.mockReset();
        checkOrgLobstertalkEndpoint.mockResolvedValue(
            {ok: true, detail: "gpt-4o-mini answered correctly", latency_ms: 812},
        );
        listAllOrgChannels.mockReset();
        listAllOrgChannels.mockResolvedValue({channels: [], total: 0});
        setOrgLobstertalkChannel.mockReset();
    });

    it("shows the triage mode picker when attention is enabled", async () => {
        await renderPage(true);
        expect(modePicker()).toBeInTheDocument();
        expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    });

    it("keeps the triage config editable when attention is disabled", async () => {
        // A stored endpoint that has gone bad must stay repairable while off:
        // hiding the form would strand the org (it can't fix the URL, and
        // re-enabling just resubmits the broken one). So the picker and the
        // LLM fields stay on screen; only the endpoint status is hidden.
        await renderPage(false);
        expect(modePicker()).toBeInTheDocument();
        expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    });

    it("shows the LLM endpoint form in llm_only mode", async () => {
        await renderPage(true, "llm_only");
        expect(modePicker()).toHaveTextContent("LLM only");
        expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
        // llm_only is the sole filter, not a confirm step, and it fails closed.
        expect(screen.getByRole("heading", {name: "LLM triage"})).toBeInTheDocument();
        expect(screen.getByText(/no nudges are sent/)).toBeInTheDocument();
    });

    it("hands LLM-mode save feedback to the endpoint status, not a toast", async () => {
        // A toast would declare success moments before the probe can
        // contradict it: the status's pending line carries the save note.
        await renderPage(true);
        setOrgLobstertalk.mockResolvedValue(settings(true));
        fireEvent.click(screen.getByRole("button", {name: "Save"}));
        await waitFor(() => {
            expect(screen.getByRole("status")).toBeInTheDocument();
        });
        expect(toastSuccess).not.toHaveBeenCalled();
        expect(setOrgLobstertalk).toHaveBeenCalledWith(
            "org-1",
            expect.objectContaining({mode: "cascade", enabled: true}),
        );
    });

    it("notes a replaced key in the checking line", async () => {
        // Resolve the probe only on demand so the pending state is stable
        // while we assert on it.
        let release: (v: unknown) => void = () => { /* replaced by the mock below */ };
        checkOrgLobstertalkEndpoint.mockImplementation(
            () => new Promise((resolve) => { release = resolve; }),
        );
        await renderPage(true);
        setOrgLobstertalk.mockResolvedValue(settings(true));
        fireEvent.click(screen.getByRole("button", {name: "Replace"}));
        fireEvent.change(screen.getByLabelText("API key"), {target: {value: "sk-new"}});
        fireEvent.click(screen.getByRole("button", {name: "Save"}));
        await waitFor(() => {
            expect(screen.getByRole("status")).toHaveTextContent("Settings saved, API key stored");
        });
        expect(setOrgLobstertalk).toHaveBeenCalledWith(
            "org-1",
            expect.objectContaining({api_key: "sk-new"}),
        );
        release({ok: true, detail: "done", latency_ms: 1});
    });

    it("removes a stored key on save", async () => {
        await renderPage(true);
        setOrgLobstertalk.mockResolvedValue(settings(true));
        fireEvent.click(screen.getByRole("button", {name: "Remove"}));
        fireEvent.click(screen.getByRole("button", {name: "Save"}));
        await waitFor(() => {
            expect(setOrgLobstertalk).toHaveBeenCalledWith(
                "org-1",
                expect.objectContaining({clear_api_key: true}),
            );
        });
        expect(setOrgLobstertalk.mock.calls[0]?.[1]).not.toHaveProperty("api_key");
    });

    it("saves All messages immediately, with no endpoint form or probe", async () => {
        // 'all' has no triage: picking it persists right away (like embedding),
        // shows no LLM form, and must not fire the healthcheck: there is
        // nothing to probe and the server would 422.
        await renderPage(true);
        setOrgLobstertalk.mockResolvedValue(settings(true, "all"));
        await pickMode("All messages");
        await waitFor(() => {
            expect(toastSuccess).toHaveBeenCalledWith("LobsterTalk settings saved");
        });
        expect(setOrgLobstertalk).toHaveBeenCalledWith(
            "org-1",
            expect.objectContaining({mode: "all", enabled: true}),
        );
        expect(checkOrgLobstertalkEndpoint).not.toHaveBeenCalled();
        expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();
    });

    it("saves a cooldown step quietly and preserves it on other saves", async () => {
        await renderPage(true);
        const stored = {...settings(true), cooldown_seconds: 60};
        setOrgLobstertalk.mockResolvedValue(stored);
        getOrgLobstertalk.mockResolvedValue(stored);
        expect(cooldown()).toHaveTextContent("30");
        fireEvent.click(within(cooldown()).getByRole("button", {name: "Increase"}));
        await waitFor(() => {
            expect(setOrgLobstertalk).toHaveBeenCalledWith(
                "org-1",
                expect.objectContaining({mode: "cascade", cooldown_seconds: 60}),
            );
        });
        await waitFor(() => {
            expect(cooldown()).toHaveTextContent("60");
        });
        // A step must not spend a metered probe on the unchanged endpoint.
        expect(checkOrgLobstertalkEndpoint).not.toHaveBeenCalled();
        expect(toastSuccess).not.toHaveBeenCalled();
        // The PUT is whole-state, so the triage form's own save must carry the
        // stored override; omitting it would silently clear the cooldown.
        setOrgLobstertalk.mockClear();
        fireEvent.click(screen.getByRole("button", {name: "Save"}));
        await waitFor(() => {
            expect(setOrgLobstertalk).toHaveBeenCalledWith(
                "org-1",
                expect.objectContaining({mode: "cascade", cooldown_seconds: 60}),
            );
        });
    });

    it("stores the server default as no override", async () => {
        await renderPage(true, "cascade", {cooldown_seconds: 60});
        setOrgLobstertalk.mockResolvedValue(settings(true));
        fireEvent.click(within(cooldown()).getByRole("button", {name: "Decrease"}));
        await waitFor(() => {
            expect(setOrgLobstertalk).toHaveBeenCalledWith(
                "org-1",
                expect.objectContaining({cooldown_seconds: null}),
            );
        });
    });

    it("keeps the cooldown within 30 to 3600 seconds", async () => {
        // 30 is the floor: the old 5s floor would let a step go below it.
        await renderPage(true);
        const decrease = within(cooldown()).getByRole("button", {name: "Decrease"});
        expect(decrease).toBeDisabled();
        fireEvent.click(decrease);
        expect(setOrgLobstertalk).not.toHaveBeenCalled();
    });

    it("keeps the toast for saves with no endpoint in play", async () => {
        // Switching to embedding persists immediately and shows no endpoint
        // status: the toast is the only confirmation there.
        await renderPage(true);
        setOrgLobstertalk.mockResolvedValue(settings(true, "embedding"));
        await pickMode("Embedding only");
        await waitFor(() => {
            expect(toastSuccess).toHaveBeenCalledWith("LobsterTalk settings saved");
        });
        expect(checkOrgLobstertalkEndpoint).not.toHaveBeenCalled();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("probes the endpoint after a save and shows the verdict inline", async () => {
        await renderPage(true);
        setOrgLobstertalk.mockResolvedValue(settings(true));
        fireEvent.click(screen.getByRole("button", {name: "Save"}));
        await waitFor(() => {
            expect(screen.getByRole("status")).toHaveTextContent("Endpoint OK");
        });
        const status = screen.getByRole("status");
        expect(status).toHaveTextContent("gpt-4o-mini answered correctly");
        expect(status).toHaveTextContent("812 ms");
        expect(checkOrgLobstertalkEndpoint).toHaveBeenCalledWith("org-1");
    });

    it("keeps a failing probe's detail on screen", async () => {
        checkOrgLobstertalkEndpoint.mockResolvedValue(
            {ok: false, detail: "Error code: 401 - invalid_api_key", latency_ms: 300},
        );
        await renderPage(true);
        setOrgLobstertalk.mockResolvedValue(settings(true));
        fireEvent.click(screen.getByRole("button", {name: "Save"}));
        await waitFor(() => {
            expect(screen.getByRole("status")).toHaveTextContent("Endpoint check failed");
        });
        expect(screen.getByRole("status")).toHaveTextContent("Error code: 401 - invalid_api_key");
    });

    it("lists public channels as switches and hides private ones", async () => {
        listAllOrgChannels.mockResolvedValue({
            channels: [
                adminChannel({channel_id: "ch-1", name: "general", lobstertalk_approved: true}),
                adminChannel({channel_id: "ch-2", name: "random"}),
                adminChannel({channel_id: "ch-3", name: "secret", channel_type: "private"}),
            ],
            total: 3,
        });
        await renderPage(true);
        expect(
            await screen.findByRole("switch", {name: "LobsterTalk in general", checked: true}),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("switch", {name: "LobsterTalk in random", checked: false}),
        ).toBeInTheDocument();
        expect(screen.getByText("1 of 2 approved")).toBeInTheDocument();
        // Private channels can never be approved (the server 422s), so the
        // section doesn't even offer them.
        expect(screen.queryByText("secret")).not.toBeInTheDocument();
    });

    it("toggling a channel calls the approval API and refetches the list", async () => {
        listAllOrgChannels.mockResolvedValue({
            channels: [adminChannel({channel_id: "ch-1", name: "general"})],
            total: 1,
        });
        setOrgLobstertalkChannel.mockResolvedValue({channel_id: "ch-1", lobstertalk_approved: true});
        await renderPage(true);
        fireEvent.click(await screen.findByRole("switch", {name: "LobsterTalk in general"}));
        await waitFor(() => {
            expect(setOrgLobstertalkChannel).toHaveBeenCalledWith("org-1", "ch-1", true);
        });
        // The admin list is the source of truth for the switches: success
        // invalidates it rather than patching the cache.
        await waitFor(() => {
            expect(listAllOrgChannels).toHaveBeenCalledTimes(2);
        });
    });

    it("renders the channels section before the triage section", async () => {
        // The "where" (allowlist) is decided before the "how" (triage mode).
        await renderPage(true);
        const channels = screen.getByRole("heading", {name: "Approved channels"});
        const triage = screen.getByRole("heading", {name: "Triage"});
        expect(
            channels.compareDocumentPosition(triage) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });

    it("shows an empty state when the org has only private channels", async () => {
        listAllOrgChannels.mockResolvedValue({
            channels: [adminChannel({channel_id: "ch-1", name: "secret", channel_type: "private"})],
            total: 1,
        });
        await renderPage(true);
        expect(await screen.findByText("No public channels")).toBeInTheDocument();
    });

    it("keeps the channels section visible with a hint when LobsterTalk is off", async () => {
        // Approvals are configuration an owner can stage before flipping the
        // feature on: hiding the section would force enable first, pick later.
        await renderPage(false);
        expect(
            await screen.findByRole("heading", {name: "Approved channels"}),
        ).toBeInTheDocument();
        expect(screen.getByText(/take effect when you turn it on/)).toBeInTheDocument();
    });

    it("probes the org that was saved, not one switched to mid-save", async () => {
        // The save and its follow-up probe must stay bound to the org that was
        // active when the user clicked. Reading activeOrgId when the mutation
        // settles would spend the newly selected org's metered LLM call and
        // write the wrong cache key.
        getOrgLobstertalk.mockResolvedValue(settings(true));
        let release: (v: unknown) => void = () => { /* replaced by the mock below */ };
        setOrgLobstertalk.mockImplementation(
            () => new Promise((resolve) => { release = resolve; }),
        );
        const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
        // A fresh element each time: React bails out of re-rendering when the
        // element is referentially identical, which would silently defeat the
        // org switch this test depends on.
        const tree = () => (
            <QueryClientProvider client={client}>
                <SettingsLobstertalkPage/>
            </QueryClientProvider>
        );
        const {rerender} = render(tree());
        await masterSwitch();

        fireEvent.click(screen.getByRole("button", {name: "Save"}));
        await waitFor(() => {
            expect(setOrgLobstertalk).toHaveBeenCalledWith("org-1", expect.anything());
        });

        auth.activeOrgId = "org-2";   // user switches orgs while the save is in flight
        rerender(tree());
        await waitFor(() => {   // the switch really reached the component
            expect(getOrgLobstertalk).toHaveBeenCalledWith("org-2");
        });
        release(settings(true));

        await waitFor(() => {
            expect(checkOrgLobstertalkEndpoint).toHaveBeenCalled();
        });
        expect(checkOrgLobstertalkEndpoint).toHaveBeenCalledWith("org-1");
    });
});
