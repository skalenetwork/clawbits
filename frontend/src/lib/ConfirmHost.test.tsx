import {act, render, screen, waitFor} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";

import {ConfirmHost} from "./ConfirmHost";
import {confirm} from "./confirm";

/**
 * The extra action exists so a user can save a copy of something before
 * agreeing to destroy it (exporting a DM on the way out). Everything worth
 * testing here is about that button NOT settling the decision, and about it
 * telling the truth when the save fails — a dialog that says "Exported" over
 * a failed download would talk someone into an irreversible delete.
 */
describe("ConfirmHost extraAction", () => {
    beforeEach(() => {
        render(<ConfirmHost/>);
    });

    it("runs the action without resolving the prompt", async () => {
        const run = vi.fn(() => Promise.resolve());
        const settled = vi.fn();
        void confirm({
            title: "Delete this channel?",
            extraAction: {label: "Export chat", doneLabel: "Exported", run},
        }).then(settled);

        const button = await screen.findByRole("button", {name: "Export chat"});
        act(() => { button.click(); });

        await screen.findByRole("button", {name: "Exported"});
        expect(run).toHaveBeenCalledTimes(1);
        // The user still has both real choices in front of them.
        expect(settled).not.toHaveBeenCalled();
        expect(screen.getByRole("button", {name: "Confirm"})).toBeInTheDocument();
    });

    it("keeps the button spent after a successful run", async () => {
        const run = vi.fn(() => Promise.resolve());
        void confirm({
            title: "Delete this channel?",
            extraAction: {label: "Export chat", doneLabel: "Exported", run},
        });

        const exportBtn = await screen.findByRole("button", {name: "Export chat"});
        act(() => { exportBtn.click(); });
        const done = await screen.findByRole("button", {name: "Exported"});

        expect(done).toBeDisabled();
        act(() => { done.click(); });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("re-enables and does not claim success when the action fails", async () => {
        const run = vi
            .fn<() => Promise<unknown>>()
            .mockRejectedValueOnce(new Error("network down"))
            .mockResolvedValueOnce(undefined);
        void confirm({
            title: "Delete this channel?",
            extraAction: {label: "Export chat", doneLabel: "Exported", run},
        });

        const exportBtn = await screen.findByRole("button", {name: "Export chat"});
        act(() => { exportBtn.click(); });

        // Back to the original label — never "Exported", which would imply a
        // copy is safely on disk.
        const retry = await screen.findByRole("button", {name: "Export chat"});
        await waitFor(() => { expect(retry).not.toBeDisabled(); });
        expect(screen.queryByRole("button", {name: "Exported"})).toBeNull();

        // ...and the failure is retryable in place.
        act(() => { retry.click(); });
        await screen.findByRole("button", {name: "Exported"});
        expect(run).toHaveBeenCalledTimes(2);
    });

    it("still resolves true when the user confirms after exporting", async () => {
        const settled = vi.fn();
        void confirm({
            title: "Delete this channel?",
            confirmLabel: "Leave & delete",
            extraAction: {
                label: "Export chat",
                doneLabel: "Exported",
                run: () => Promise.resolve(),
            },
        }).then(settled);

        const exportBtn = await screen.findByRole("button", {name: "Export chat"});
        act(() => { exportBtn.click(); });
        await screen.findByRole("button", {name: "Exported"});
        act(() => { screen.getByRole("button", {name: "Leave & delete"}).click(); });

        await waitFor(() => { expect(settled).toHaveBeenCalledWith(true); });
    });

    it("does not carry a spent state into the next prompt", async () => {
        void confirm({
            title: "First",
            extraAction: {
                label: "Export chat",
                doneLabel: "Exported",
                run: () => Promise.resolve(),
            },
        });
        const exportBtn = await screen.findByRole("button", {name: "Export chat"});
        act(() => { exportBtn.click(); });
        await screen.findByRole("button", {name: "Exported"});

        // A second prompt replaces the first outright (the host is a
        // singleton); its button must start fresh.
        void confirm({
            title: "Second",
            extraAction: {
                label: "Export chat",
                doneLabel: "Exported",
                run: () => Promise.resolve(),
            },
        });

        const fresh = await screen.findByRole("button", {name: "Export chat"});
        expect(fresh).not.toBeDisabled();
    });

    it("renders no extra button when the caller offers no action", async () => {
        void confirm({title: "Leave channel?"});
        await screen.findByText("Leave channel?");
        expect(screen.queryByRole("button", {name: "Export chat"})).toBeNull();
    });
});
