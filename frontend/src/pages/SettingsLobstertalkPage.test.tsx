import {beforeEach, describe, expect, it, vi} from "vitest";
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {OrgLobstertalkSettings, SetOrgLobstertalkBody} from "@/lib/api";

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
vi.mock("@/lib/api", () => ({
    getOrgLobstertalk: (orgId: string) => getOrgLobstertalk(orgId) as Promise<OrgLobstertalkSettings>,
    setOrgLobstertalk: (orgId: string, body: SetOrgLobstertalkBody) =>
        setOrgLobstertalk(orgId, body) as Promise<OrgLobstertalkSettings>,
    checkOrgLobstertalkEndpoint: (orgId: string) =>
        checkOrgLobstertalkEndpoint(orgId) as Promise<unknown>,
}));

const toastSuccess = vi.fn();
vi.mock("@/lib/toast", () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccess(...args),
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

async function renderPage(enabled: boolean, mode?: OrgLobstertalkSettings["mode"]) {
    getOrgLobstertalk.mockResolvedValue(settings(enabled, mode));
    // Retries would stall the test on an unexpected rejection.
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    render(
        <QueryClientProvider client={client}>
            <SettingsLobstertalkPage/>
        </QueryClientProvider>,
    );
    // The attention switch renders in the same pass as the triage section, so
    // awaiting it means an absent picker is really absent, not just pending.
    await screen.findByLabelText("LobsterTalk attention for this organization");
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
    });

    it("shows the triage mode picker when attention is enabled", async () => {
        await renderPage(true);
        expect(screen.getByRole("radiogroup", {name: "Triage mode"})).toBeInTheDocument();
        expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    });

    it("keeps the triage config editable when attention is disabled", async () => {
        // A stored endpoint that has gone bad must stay repairable while off —
        // hiding the form would strand the org (it can't fix the URL, and
        // re-enabling just resubmits the broken one). So the picker and the
        // LLM fields stay on screen; only the post-save health card is hidden.
        await renderPage(false);
        expect(screen.getByRole("radiogroup", {name: "Triage mode"})).toBeInTheDocument();
        expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    });

    it("shows the LLM endpoint form in llm_only mode", async () => {
        await renderPage(true, "llm_only");
        expect(screen.getByRole("radio", {name: "LLM only", checked: true})).toBeInTheDocument();
        expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
        // llm_only is the sole filter, not a confirm step — and it fails closed.
        expect(screen.getByRole("heading", {name: "LLM triage"})).toBeInTheDocument();
        expect(screen.getByText(/no nudges are sent/)).toBeInTheDocument();
    });

    it("hands LLM-mode save feedback to the health card, not a toast", async () => {
        // A toast would declare success moments before the probe can
        // contradict it — the card's pending line carries the save note.
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

    it("notes a stored key in the checking line", async () => {
        // Resolve the probe only on demand so the pending state is stable
        // while we assert on it.
        let release: (v: unknown) => void = () => {};
        checkOrgLobstertalkEndpoint.mockImplementation(
            () => new Promise((resolve) => { release = resolve; }),
        );
        await renderPage(true);
        setOrgLobstertalk.mockResolvedValue(settings(true));
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

    it("saves All messages immediately, with no endpoint form or probe", async () => {
        // 'all' has no triage: picking it persists right away (like embedding),
        // shows no LLM form, and must not fire the healthcheck — there is
        // nothing to probe and the server would 422.
        await renderPage(true);
        setOrgLobstertalk.mockResolvedValue(settings(true, "all"));
        fireEvent.click(screen.getByRole("radio", {name: "All messages"}));
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

    it("saves a cooldown override and preserves it on other saves", async () => {
        await renderPage(true);
        const stored = {...settings(true), cooldown_seconds: 60};
        setOrgLobstertalk.mockResolvedValue(stored);
        getOrgLobstertalk.mockResolvedValue(stored); // post-save refetch result
        const input = screen.getByLabelText("Nudge cooldown in seconds");
        expect(input).toHaveAttribute("placeholder", "30 (server default)");
        fireEvent.change(input, {target: {value: "60"}});
        fireEvent.click(screen.getByRole("button", {name: "Save cooldown"}));
        await waitFor(() => {
            expect(setOrgLobstertalk).toHaveBeenCalledWith(
                "org-1",
                expect.objectContaining({cooldown_seconds: 60}),
            );
        });
        // Wait for the refetch to land (the section remounts showing 60), then
        // check the triage form's own save carries the stored override — the
        // PUT is whole-state, so omitting it would silently clear the cooldown.
        await waitFor(() => {
            expect(screen.getByLabelText("Nudge cooldown in seconds")).toHaveValue(60);
        });
        setOrgLobstertalk.mockClear();
        fireEvent.click(screen.getByRole("button", {name: "Save"}));
        await waitFor(() => {
            expect(setOrgLobstertalk).toHaveBeenCalledWith(
                "org-1",
                expect.objectContaining({mode: "cascade", cooldown_seconds: 60}),
            );
        });
    });

    it("rejects an out-of-range cooldown without saving", async () => {
        await renderPage(true);
        const input = screen.getByLabelText("Nudge cooldown in seconds");
        // 29 is the interesting value: it was accepted under the old 5s floor,
        // so this pins the raise rather than just "some small number is bad".
        fireEvent.change(input, {target: {value: "29"}});
        expect(screen.getByText(/between 30 and 3600/)).toBeInTheDocument();
        expect(screen.getByRole("button", {name: "Save cooldown"})).toBeDisabled();
        expect(setOrgLobstertalk).not.toHaveBeenCalled();
    });

    it("keeps the toast for saves with no endpoint in play", async () => {
        // Switching to embedding persists immediately and renders no health
        // card — the toast is the only confirmation there.
        await renderPage(true);
        setOrgLobstertalk.mockResolvedValue(settings(true, "embedding"));
        fireEvent.click(screen.getByRole("radio", {name: "Embedding only"}));
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

    it("probes the org that was saved, not one switched to mid-save", async () => {
        // The save and its follow-up probe must stay bound to the org that was
        // active when the user clicked. Reading activeOrgId when the mutation
        // settles would spend the *newly* selected org's metered LLM call and
        // invalidate the wrong cache key.
        getOrgLobstertalk.mockResolvedValue(settings(true));
        let release: (v: unknown) => void = () => {};
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
        await screen.findByLabelText("LobsterTalk attention for this organization");

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
