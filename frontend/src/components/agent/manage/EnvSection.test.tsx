/**
 * EnvSection — the states the browser can't easily be driven into (a loaded
 * list needs a real reef admin token), plus the two invariants this section
 * exists to guarantee: saves always go out as ``apply:"restart"``, and an agent
 * that can't take an in-place restart is read-only rather than being offered
 * the destructive recreate path.
 */
import {beforeEach, describe, expect, it, vi} from "vitest";
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {ReefAuthError} from "@/lib/reefApi";
import type {ReefAgentEnvView, ReefEnvApplyResult, ReefEnvPatchBody} from "@/lib/reefApi";
import {EnvSection} from "./EnvSection";

const reefAgentEnv = vi.fn();
const reefPatchEnv = vi.fn();
const setReefToken = vi.fn();
// Unlocked by default; the token gate flips this to exercise the locked branch.
let tokenHeld = true;
vi.mock("@/lib/reefApi", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/reefApi")>();
    return {
        ...actual,
        hasReefToken: () => tokenHeld,
        setReefToken: (...a: unknown[]) => { setReefToken(...a); },
        reefAgentEnv: (...a: unknown[]) => reefAgentEnv(...a) as Promise<ReefAgentEnvView>,
        reefPatchEnv: (...a: unknown[]) => reefPatchEnv(...a) as Promise<ReefEnvApplyResult>,
    };
});

vi.mock("@/lib/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/api")>();
    return {
        ...actual,
        getReefConnection: () => Promise.resolve({api_url: "http://reef.test"}),
    };
});

vi.mock("@/lib/toast", () => ({
    toast: {success: vi.fn(), error: vi.fn()},
    errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

function envView(over: Partial<ReefAgentEnvView> = {}): ReefAgentEnvView {
    return {
        sandbox_id: "oc1",
        vars: [{key: "ANTHROPIC_API_KEY", value_length: 32, source: "file", tier: "secret", value: null}],
        editable: true,
        apply_modes: ["restart", "recreate"],
        state: "running",
        desired_state: "running",
        ...over,
    };
}

function mount(view: ReefAgentEnvView) {
    reefAgentEnv.mockResolvedValue(view);
    const qc = new QueryClient({defaultOptions: {queries: {retry: false}}});
    return render(
        <QueryClientProvider client={qc}>
            <EnvSection orgId="org-1" sandboxId="oc1"/>
        </QueryClientProvider>,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    tokenHeld = true;
    reefPatchEnv.mockResolvedValue({
        sandbox_id: "oc1",
        changed: true,
        applied: "restart",
        takes_effect: "now",
        state: "running",
        vars: [],
    } satisfies ReefEnvApplyResult);
});

/** Open a row's action menu and pick an item. Edit and Delete live behind it. */
async function menu(rowKey: string, item: "Edit" | "Delete") {
    fireEvent.click(screen.getByLabelText(`Actions for ${rowKey}`));
    const entry = await screen.findByText(item);
    fireEvent.click(entry);
}

describe("EnvSection", () => {
    it("lists the keys and shows a secret as dots, never as a value", async () => {
        mount(envView());
        expect(await screen.findByText("ANTHROPIC_API_KEY")).toBeTruthy();
        expect(screen.getByText("••••••••••••")).toBeTruthy();
    });

    it("marks a set-but-empty value as empty rather than as dots", async () => {
        mount(envView({vars: [{key: "FEATURE_FLAG", value_length: 0, source: "file", tier: "secret", value: null}]}));
        expect(await screen.findByText("empty")).toBeTruthy();
    });

    it("saves with apply:'restart' - the only mode this page ever sends", async () => {
        mount(envView());
        await screen.findByText("ANTHROPIC_API_KEY");

        fireEvent.click(screen.getByText("Add"));
        fireEvent.change(screen.getByPlaceholderText("name"), {target: {value: "NEW_KEY"}});
        fireEvent.change(screen.getByPlaceholderText("value"), {target: {value: "v"}});
        fireEvent.click(screen.getByText("Save"));

        await waitFor(() => { expect(reefPatchEnv).toHaveBeenCalled(); });
        const body = reefPatchEnv.mock.calls[0]?.[2] as ReefEnvPatchBody;
        expect(body.apply).toBe("restart");
        expect(body.set).toEqual({NEW_KEY: "v"});
        expect(body.unset).toEqual([]);
    });

    it("removing an existing key unsets it", async () => {
        mount(envView());
        await screen.findByText("ANTHROPIC_API_KEY");

        await menu("ANTHROPIC_API_KEY", "Delete");
        expect(screen.getByText("Removing")).toBeTruthy();
        fireEvent.click(screen.getByText("Save"));

        await waitFor(() => { expect(reefPatchEnv).toHaveBeenCalled(); });
        const body = reefPatchEnv.mock.calls[0]?.[2] as ReefEnvPatchBody;
        expect(body.unset).toEqual(["ANTHROPIC_API_KEY"]);
        expect(body.apply).toBe("restart");
    });

    it("is read-only on an image with no in-place reader, and never offers recreate", async () => {
        mount(envView({apply_modes: ["recreate"]}));
        expect(await screen.findByText(/read-only until this agent is updated/i)).toBeTruthy();
        expect(screen.queryByText("Add")).toBeNull();
        expect(screen.queryByText(/recreate/i)).toBeNull();
    });

    it("shows a value as you type it, and can hide it on demand", async () => {
        mount(envView());
        await screen.findByText("ANTHROPIC_API_KEY");
        fireEvent.click(screen.getByText("Add"));

        // Visible by default: masking your own keystrokes buys nothing and makes
        // a long key impossible to proofread.
        const field = screen.getByPlaceholderText("value");
        expect(field.getAttribute("type")).toBe("text");

        fireEvent.click(screen.getByLabelText("Hide value"));
        expect(screen.getByPlaceholderText("value").getAttribute("type")).toBe("password");

        fireEvent.click(screen.getByLabelText("Show value"));
        expect(screen.getByPlaceholderText("value").getAttribute("type")).toBe("text");
    });

    it("offers no visibility toggle for a STORED secret - reef withholds it", async () => {
        mount(envView());
        await screen.findByText("ANTHROPIC_API_KEY");
        expect(screen.queryByLabelText("Show value")).toBeNull();
        expect(screen.queryByLabelText("Hide value")).toBeNull();
    });

    // ── Tiers ────────────────────────────────────────────────────────────────
    const REGULAR = {
        key: "ALGOLIA_APP_ID",
        value_length: 10,
        source: "file",
        tier: "regular" as const,
        value: "PLZ8QK4C1N",
    };

    it("shows a regular value in full, and offers to copy it", async () => {
        mount(envView({vars: [REGULAR]}));
        expect(await screen.findByText("PLZ8QK4C1N")).toBeTruthy();
        expect(screen.getByLabelText(/^Copy/)).toBeTruthy();
    });

    it("never renders a secret's value, only its length as dots", async () => {
        mount(envView({
            vars: [{key: "SESSION_SECRET", value_length: 7, source: "file",
                    tier: "secret", value: null}],
        }));
        await screen.findByText("SESSION_SECRET");
        expect(screen.getByText("••••••••••••")).toBeTruthy();
        expect(screen.queryByLabelText(/^Copy/)).toBeNull();
    });

    it("defaults a new key by its NAME, so a credential is not published by accident", async () => {
        mount(envView({vars: []}));
        await waitFor(() => { expect(screen.getByText("Add")).toBeTruthy(); });

        fireEvent.click(screen.getByText("Add"));
        fireEvent.change(screen.getByPlaceholderText("name"), {target: {value: "STRIPE_SECRET_KEY"}});
        // A new row opens in edit mode, so the tier control is present.
        // Credential-shaped -> hidden, so the control offers to REVEAL it.
        expect(screen.getByLabelText("Make this value readable")).toBeTruthy();

        fireEvent.change(screen.getByPlaceholderText("name"), {target: {value: "PUBLIC_URL"}});
        // Not credential-shaped -> readable, so the control offers to HIDE it.
        expect(screen.getByLabelText("Keep this value hidden")).toBeTruthy();
    });

    it("sends an explicit tier only when the user overrides it", async () => {
        mount(envView({vars: []}));
        await waitFor(() => { expect(screen.getByText("Add")).toBeTruthy(); });
        fireEvent.click(screen.getByText("Add"));
        fireEvent.change(screen.getByPlaceholderText("name"), {target: {value: "PUBLIC_URL"}});
        fireEvent.change(screen.getByPlaceholderText("value"), {target: {value: "https://x.test"}});

        // Untouched: reef applies its own default, so no tier rides along.
        fireEvent.click(screen.getByText("Save"));
        await waitFor(() => { expect(reefPatchEnv).toHaveBeenCalled(); });
        expect((reefPatchEnv.mock.calls[0]?.[2] as ReefEnvPatchBody).tiers).toBeUndefined();
    });

    it("flipping a stored secret to readable asks for the value, which reef requires", async () => {
        mount(envView());
        await screen.findByText("ANTHROPIC_API_KEY");

        await menu("ANTHROPIC_API_KEY", "Edit");
        // The tier control only exists while editing.
        fireEvent.click(screen.getByLabelText("Make this value readable"));
        // reef refuses secret -> regular without the value, so the UI collects it
        // instead of letting the save come back a 422.
        expect(screen.getByPlaceholderText("value")).toBeTruthy();

        fireEvent.change(screen.getByPlaceholderText("value"), {target: {value: "re-entered"}});
        fireEvent.click(screen.getByText("Save"));
        await waitFor(() => { expect(reefPatchEnv).toHaveBeenCalled(); });
        const body = reefPatchEnv.mock.calls[0]?.[2] as ReefEnvPatchBody;
        expect(body.tiers).toEqual({ANTHROPIC_API_KEY: "regular"});
        expect(body.set).toEqual({ANTHROPIC_API_KEY: "re-entered"});
    });

    it("hiding a regular value needs no re-entry", async () => {
        mount(envView({vars: [REGULAR]}));
        await screen.findByText("ALGOLIA_APP_ID");
        await menu("ALGOLIA_APP_ID", "Edit");
        fireEvent.click(screen.getByLabelText("Keep this value hidden"));
        fireEvent.click(screen.getByText("Save"));
        await waitFor(() => { expect(reefPatchEnv).toHaveBeenCalled(); });
        const body = reefPatchEnv.mock.calls[0]?.[2] as ReefEnvPatchBody;
        expect(body.tiers).toEqual({ALGOLIA_APP_ID: "secret"});
        expect(body.set).toEqual({});
    });

    it("hides the apply mode from the user entirely", async () => {
        mount(envView());
        await screen.findByText("ANTHROPIC_API_KEY");
        // No picker, no mode names, nothing to choose.
        for (const word of [/restart/i, /recreate/i, /apply mode/i]) {
            expect(screen.queryByText(word)).toBeNull();
        }
    });
});

describe("EnvSection reading vs editing", () => {
    it("does not enter edit mode when the value is clicked", async () => {
        mount(envView());
        const shown = await screen.findByText("••••••••••••");
        fireEvent.click(shown);
        // Still reading: no input, and no tier control.
        expect(screen.queryByPlaceholderText("value")).toBeNull();
        expect(screen.queryByLabelText("Make this value readable")).toBeNull();
    });

    it("shows the tier control only while a row is being edited", async () => {
        mount(envView());
        await screen.findByText("ANTHROPIC_API_KEY");
        expect(screen.queryByLabelText("Make this value readable")).toBeNull();

        fireEvent.click(screen.getByLabelText("Actions for ANTHROPIC_API_KEY"));
        fireEvent.click(await screen.findByText("Edit"));
        expect(screen.getByLabelText("Make this value readable")).toBeTruthy();
    });

    it("seeds a regular value into the editor and sends nothing if it is unchanged", async () => {
        mount(envView({
            vars: [{key: "PUBLIC_URL", value_length: 14, source: "file",
                    tier: "regular", value: "https://x.test"}],
        }));
        await screen.findByText("https://x.test");

        fireEvent.click(screen.getByLabelText("Actions for PUBLIC_URL"));
        fireEvent.click(await screen.findByText("Edit"));
        // Amend, do not retype.
        expect(screen.getByPlaceholderText<HTMLInputElement>("value").value).toBe("https://x.test");

        // The bar appears (Cancel is the way out of edit mode) but there is
        // nothing to send: re-posting an unchanged value would cost the agent a
        // restart for nothing.
        expect((screen.getByText("Save").closest("button"))?.disabled).toBe(true);

        // Amending it enables the save.
        fireEvent.change(screen.getByPlaceholderText("value"), {target: {value: "https://y.test"}});
        expect((screen.getByText("Save").closest("button"))?.disabled).toBe(false);
    });
});

/**
 * The token gate. It sits in front of the list, so its whole job is to not read
 * as a *variable named* "Reef admin token" - which is what the old row-shaped
 * version did.
 */
describe("EnvSection token gate", () => {
    function mountLocked() {
        tokenHeld = false;
        reefAgentEnv.mockResolvedValue(envView());
        const qc = new QueryClient({defaultOptions: {queries: {retry: false}}});
        return render(
            <QueryClientProvider client={qc}>
                <EnvSection orgId="org-1" sandboxId="oc1"/>
            </QueryClientProvider>,
        );
    }

    it("says what unlocking gets you, not just the name of a token", async () => {
        mountLocked();
        expect(await screen.findByText(/unlock environment variables/i)).toBeTruthy();
    });

    it("answers where the token comes from and where it goes", async () => {
        mountLocked();
        // Where to get it: the same token as the operator panel, named in-app
        // rather than as a file on the reef box.
        expect(await screen.findByText(/settings . reef/i)).toBeTruthy();
        // Where it goes: the reassurance that makes pasting a credential ok.
        expect(screen.getByText(/never sent to clawbits/i)).toBeTruthy();
    });

    it("labels the field, so the copy does not vanish on first keystroke", async () => {
        mountLocked();
        // A real label, not a placeholder doing double duty as one.
        const field = await screen.findByLabelText("Reef admin token");
        expect(field.getAttribute("type")).toBe("password");
        expect(field.getAttribute("placeholder")).toBeNull();
    });

    it("does not fetch until unlocked, then submits the trimmed token", async () => {
        mountLocked();
        const field = await screen.findByLabelText("Reef admin token");
        expect(reefAgentEnv).not.toHaveBeenCalled();

        // Nothing to submit yet.
        expect((screen.getByText("Unlock").closest("button"))?.disabled).toBe(true);

        fireEvent.change(field, {target: {value: "  tok-abc  "}});
        expect((screen.getByText("Unlock").closest("button"))?.disabled).toBe(false);
        fireEvent.click(screen.getByText("Unlock"));

        expect(setReefToken).toHaveBeenCalledWith("tok-abc");
        // Unlocking runs the query that was gated on the token.
        await waitFor(() => { expect(reefAgentEnv).toHaveBeenCalled(); });
    });

    it("reports a rejected token as a live error that survives typing", async () => {
        tokenHeld = true; // held, but reef refuses it
        reefAgentEnv.mockRejectedValue(new ReefAuthError());
        const qc = new QueryClient({defaultOptions: {queries: {retry: false}}});
        render(
            <QueryClientProvider client={qc}>
                <EnvSection orgId="org-1" sandboxId="oc1"/>
            </QueryClientProvider>,
        );

        const err = await screen.findByRole("alert");
        expect(err.textContent).toMatch(/rejected/i);

        const field = screen.getByLabelText("Reef admin token");
        expect(field.getAttribute("aria-invalid")).toBe("true");
        // The old version put this in the placeholder, so it disappeared exactly
        // when the user started fixing it.
        fireEvent.change(field, {target: {value: "retry"}});
        expect(screen.getByRole("alert").textContent).toMatch(/rejected/i);
    });
});
