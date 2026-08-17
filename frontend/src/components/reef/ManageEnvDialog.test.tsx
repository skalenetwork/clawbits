import {beforeEach, describe, expect, it, vi} from "vitest";
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {ReefAgentEnvView, ReefEnvPatchBody} from "@/lib/reefApi";
import {ManageEnvDialog} from "./ManageEnvDialog";

// The dialog's own useMutation result, captured on every render.
let mutation: {status: string; data: unknown; error: unknown} | null = null;
vi.mock("@tanstack/react-query", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@tanstack/react-query")>();
    return {
        ...actual,
        useMutation: (opts: Parameters<typeof actual.useMutation>[0]) => {
            const res = actual.useMutation(opts);
            mutation = {status: res.status, data: res.data, error: res.error};
            return res;
        },
    };
});

const reefAgentEnv = vi.fn();
const reefPatchEnv = vi.fn();
vi.mock("@/lib/reefApi", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/reefApi")>();
    return {
        ...actual,
        reefAgentEnv: (...a: unknown[]) => reefAgentEnv(...a) as Promise<ReefAgentEnvView>,
        reefPatchEnv: (...a: unknown[]) => reefPatchEnv(...a) as Promise<unknown>,
    };
});

vi.mock("@/lib/toast", () => ({
    toast: {success: vi.fn(), error: vi.fn()},
    errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const {ReefRequestError} = await import("@/lib/reefApi");

function envView(over: Partial<ReefAgentEnvView>): ReefAgentEnvView {
    return {
        sandbox_id: "oc1",
        vars: [{key: "AGENTPIT_API_KEY", value_length: 32, source: "file", tier: "secret", value: null}],
        editable: true,
        apply_modes: ["restart", "recreate"],
        state: "running",
        desired_state: "running",
        ...over,
    };
}

const onClose = vi.fn();
const onAuthReject = vi.fn();

function mount(view: ReefAgentEnvView, managed = true) {
    reefAgentEnv.mockResolvedValue(view);
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    return render(
        <QueryClientProvider client={client}>
            <ManageEnvDialog
                sandboxId="oc1"
                managed={managed}
                apiUrl="https://reef.example"
                orgId="org-1"
                onClose={onClose}
                onAuthReject={onAuthReject}
            />
        </QueryClientProvider>,
    );
}

function last(els: HTMLElement[]): HTMLElement {
    const el = els.at(-1);
    if (el === undefined) throw new Error("expected at least one matching element");
    return el;
}

async function draftAChange() {
    fireEvent.click(await screen.findByText("Add variable"));
    fireEvent.change(last(screen.getAllByPlaceholderText("NAME")), {
        target: {value: "NEW_KEY"},
    });
    fireEvent.change(last(screen.getAllByPlaceholderText("value")), {
        target: {value: "fixture-not-a-secret"},
    });
}

const patchBody = () => (reefPatchEnv.mock.calls[0]?.[2] ?? null) as ReefEnvPatchBody | null;

beforeEach(() => {
    vi.clearAllMocks();
    mutation = null;
    reefPatchEnv.mockResolvedValue({
        sandbox_id: "oc1", changed: true, applied: "restart",
        takes_effect: "now", state: "running", vars: [],
    });
});

describe("apply truth table, as rendered", () => {
    it("running + restart-capable: offers all three, commits as restart", async () => {
        mount(envView({}));
        await draftAChange();
        expect(screen.getByText("Restart")).toBeInTheDocument();
        expect(screen.getByText("Recreate")).toBeInTheDocument();
        expect(screen.getByText("Don't apply")).toBeInTheDocument();

        fireEvent.click(screen.getByText("Save changes"));
        expect(screen.getByText("Restart and apply")).toBeInTheDocument();
        fireEvent.click(screen.getByText("Restart and apply"));
        await waitFor(() => { expect(reefPatchEnv).toHaveBeenCalledTimes(1); });
        expect(patchBody()?.apply).toBe("restart");
    });

    it("running + recreate-only: no picker, no \"Don't apply\", commits as recreate", async () => {
        mount(envView({apply_modes: ["recreate"]}));
        await draftAChange();
        expect(screen.queryByText("Don't apply")).not.toBeInTheDocument();
        expect(screen.queryByText("Restart")).not.toBeInTheDocument();
        expect(screen.getByText(/can't read variables from disk/)).toBeInTheDocument();

        fireEvent.click(screen.getByText("Save changes"));
        expect(screen.getByText("Recreate agent")).toBeInTheDocument();
        fireEvent.click(screen.getByText("Recreate agent"));
        await waitFor(() => { expect(reefPatchEnv).toHaveBeenCalledTimes(1); });
        expect(patchBody()?.apply).toBe("recreate");
    });

    it("running but deliberately stopped: no picker, promises a write, not a restart", async () => {
        mount(envView({state: "running", desired_state: "stopped"}));
        await draftAChange();
        expect(screen.queryByText("Don't apply")).not.toBeInTheDocument();
        expect(screen.queryByText("Recreate")).not.toBeInTheDocument();
        expect(screen.queryByText(/nothing to restart/)).not.toBeInTheDocument();
        expect(screen.getByText(/You stopped this agent, so reef writes/)).toBeInTheDocument();

        fireEvent.click(screen.getByText("Save changes"));
        expect(screen.queryByText(/restarts in place/)).not.toBeInTheDocument();
        expect(screen.getByText(/never starts an agent back up/)).toBeInTheDocument();
        fireEvent.click(screen.getByText("Save"));
        await waitFor(() => { expect(reefPatchEnv).toHaveBeenCalledTimes(1); });
        expect(patchBody()?.apply).toBe("restart");
    });

    it("running but deliberately stopped + recreate-only: says it stays stopped", async () => {
        mount(envView({state: "running", desired_state: "stopped", apply_modes: ["recreate"]}));
        await draftAChange();
        fireEvent.click(screen.getByText("Save changes"));
        expect(screen.getByText(/stays stopped afterwards/)).toBeInTheDocument();
        fireEvent.click(screen.getByText("Recreate agent"));
        await waitFor(() => { expect(reefPatchEnv).toHaveBeenCalledTimes(1); });
        expect(patchBody()?.apply).toBe("recreate");
    });

    it('stopped + restart-capable: no picker, commits as restart (never "none")', async () => {
        mount(envView({state: "stopped", desired_state: "stopped"}));
        await draftAChange();
        expect(screen.queryByText("Don't apply")).not.toBeInTheDocument();
        expect(screen.getByText(/nothing to restart/)).toBeInTheDocument();

        fireEvent.click(screen.getByText("Save changes"));
        expect(screen.getByText("Save")).toBeInTheDocument();
        fireEvent.click(screen.getByText("Save"));
        await waitFor(() => { expect(reefPatchEnv).toHaveBeenCalledTimes(1); });
        expect(patchBody()?.apply).toBe("restart");
    });

    it("stopped + recreate-only: commits as recreate, and says it stays down", async () => {
        mount(envView({state: "stopped", desired_state: "stopped", apply_modes: ["recreate"]}));
        await draftAChange();
        expect(screen.queryByText("Don't apply")).not.toBeInTheDocument();

        fireEvent.click(screen.getByText("Save changes"));
        expect(screen.getByText(/stays stopped afterwards/)).toBeInTheDocument();
        fireEvent.click(screen.getByText("Recreate agent"));
        await waitFor(() => { expect(reefPatchEnv).toHaveBeenCalledTimes(1); });
        expect(patchBody()?.apply).toBe("recreate");
    });

    it("drift VM (editable=false, unmanaged) offers no apply mode and no save", async () => {
        mount(envView({editable: false}), false);
        await screen.findByText(/no record for this VM/);
        expect(screen.queryByText("Don't apply")).not.toBeInTheDocument();
        expect(screen.queryByText("Add variable")).not.toBeInTheDocument();
        expect(screen.getByText("Save changes")).toBeDisabled();
    });

    it("degraded read (editable=false, managed) says the list is incomplete, not that it's a drift VM", async () => {
        mount(envView({editable: false}), true);
        await screen.findByText(/this list is incomplete/);
        expect(screen.queryByText(/no record for this VM/)).not.toBeInTheDocument();
        expect(screen.queryByText("Add variable")).not.toBeInTheDocument();
        expect(screen.getByText("Save changes")).toBeDisabled();
    });
});

describe("failures and hygiene", () => {
    it("surfaces reef's 422 wording inline, not only in a toast", async () => {
        mount(envView({apply_modes: ["recreate"]}));
        const detail = 'this agent\'s image predates the in-place env file: run upgrade first, '
            + 'or retry with apply="recreate"';
        reefPatchEnv.mockRejectedValue(new ReefRequestError(422, detail));
        await draftAChange();
        fireEvent.click(screen.getByText("Save changes"));
        fireEvent.click(screen.getByText("Recreate agent"));
        expect(await screen.findByText(detail)).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("resets the mutation on SUCCESS, not only on error", async () => {
        mount(envView({}));
        await draftAChange();
        fireEvent.click(screen.getByText("Save changes"));
        fireEvent.click(screen.getByText("Restart and apply"));
        await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
        expect(patchBody()?.set).toEqual({NEW_KEY: "fixture-not-a-secret"});
        await waitFor(() => { expect(mutation?.status).toBe("idle"); });
        expect(mutation?.data).toBeUndefined();
    });

    it("resets the mutation after an ERROR too", async () => {
        mount(envView({}));
        reefPatchEnv.mockRejectedValue(new ReefRequestError(500, "boom"));
        await draftAChange();
        fireEvent.click(screen.getByText("Save changes"));
        fireEvent.click(screen.getByText("Restart and apply"));
        await screen.findByText("boom");
        await waitFor(() => { expect(mutation?.status).toBe("idle"); });
        expect(mutation?.error).toBeNull();
    });

    it("has no \"Managed by reef\" disclosure, and hides no row behind one", async () => {
        mount(envView({
            vars: [
                {key: "AGENTPIT_API_KEY", value_length: 32, source: "file", tier: "secret", value: null},
                {key: "LEGACY_KEY", value_length: 8, source: "container", tier: "secret", value: null},
                {key: "FROM_THE_FUTURE", value_length: 4, source: "something-new", tier: "secret", value: null},
            ],
        }));
        await screen.findByDisplayValue("AGENTPIT_API_KEY");
        expect(screen.getByDisplayValue("LEGACY_KEY")).toBeInTheDocument();
        expect(screen.getByDisplayValue("FROM_THE_FUTURE")).toBeInTheDocument();
        expect(screen.queryByText(/Managed by reef/)).not.toBeInTheDocument();
    });

    it("says a cleared box keeps the stored value, and sends nothing for it", async () => {
        mount(envView({}));
        await screen.findByDisplayValue("AGENTPIT_API_KEY");
        expect(screen.getByText(/clearing it doesn't blank it/)).toBeInTheDocument();
        expect(screen.getByPlaceholderText("unchanged (32 chars)")).toBeInTheDocument();

        const stored = screen.getByPlaceholderText("unchanged (32 chars)");
        fireEvent.change(stored, {target: {value: "typed-then-regretted"}});
        fireEvent.change(stored, {target: {value: ""}});
        expect(screen.getByText("Save changes")).toBeDisabled();

        await draftAChange();
        fireEvent.click(screen.getByText("Save changes"));
        fireEvent.click(screen.getByText("Restart and apply"));
        await waitFor(() => { expect(reefPatchEnv).toHaveBeenCalledTimes(1); });
        expect(patchBody()?.set).toEqual({NEW_KEY: "fixture-not-a-secret"});
        expect(patchBody()?.unset).toEqual([]);
    });
});
