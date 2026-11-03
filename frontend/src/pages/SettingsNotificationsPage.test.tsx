import {describe, expect, it, vi} from "vitest";
import {render, screen} from "@testing-library/react";
import type {NotificationDiagnostics} from "@/lib/desktop";
import type {PushUiStatus} from "@/lib/push";

// Mutable so one file covers the web page and the desktop app's.
const shell = {desktop: false};
const diagnostics: NotificationDiagnostics = {
    serverName: "mako",
    desktopEntry: "ai.clawbits.desktop",
    desktopFile: "/usr/share/applications/ai.clawbits.desktop.desktop",
    error: null,
};
vi.mock("@/lib/desktop", () => ({
    get isDesktop() { return shell.desktop; },
    getNotificationDiagnostics: () => Promise.resolve(shell.desktop ? diagnostics : null),
    sendTestNotification: vi.fn(),
}));

const push: {status: PushUiStatus} = {status: "prompt"};
vi.mock("@/lib/push", () => ({
    usePushSubscription: () => ({status: push.status, busy: false, enable: vi.fn(), disable: vi.fn()}),
}));

vi.mock("@/lib/toast", () => ({toast: {success: vi.fn(), error: vi.fn()}}));

const {default: SettingsNotificationsPage} = await import("./SettingsNotificationsPage");

const SCOPE =
    /^With notifications on, you get a banner for new messages, and one per game when it waits on your move .*Muting a chat silences both/;

describe("SettingsNotificationsPage", () => {
    it("says on the web that banners come for messages and for a game's move, and that mute silences both", () => {
        shell.desktop = false;
        push.status = "prompt";
        render(<SettingsNotificationsPage/>);

        expect(screen.getByText(SCOPE)).toBeInTheDocument();
        expect(screen.getByText("Get notifications on this device")).toBeInTheDocument();
    });

    it("says it only of notifications that are on, so a browser that blocks them isn't contradicted", () => {
        shell.desktop = false;
        push.status = "denied";
        render(<SettingsNotificationsPage/>);

        expect(screen.getByText(/^Blocked in your browser/)).toBeInTheDocument();
        expect(screen.getByText(SCOPE)).toBeInTheDocument();
    });

    it("says the same in the desktop app, above the delivery report", async () => {
        shell.desktop = true;
        render(<SettingsNotificationsPage/>);

        const scope = screen.getByText(SCOPE);
        const report = await screen.findByText("Delivered by mako");
        expect(scope.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});
