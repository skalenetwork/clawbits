import {describe, expect, it, vi} from "vitest";
import {render, screen} from "@testing-library/react";
import {MemoryRouter} from "react-router-dom";
import type {Automation} from "@/lib/api";
import {AUTOMATION_TEMPLATES} from "@/lib/automations";
import {RecipeShelf} from "./RecipeShelf";

const AGENTPIT = AUTOMATION_TEMPLATES.find(t => t.id === "agentpit-trading");
if (!AGENTPIT) throw new Error("the AgentPit recipe left the catalog");

function automationNamed(name: string): Automation {
    return {name} as Automation;
}

function renderShelf(automations: Automation[]) {
    return render(
        <MemoryRouter>
            <RecipeShelf automations={automations} base="/agents/a/automations" selectedId={null} onPick={vi.fn()}/>
        </MemoryRouter>,
    );
}

describe("RecipeShelf", () => {
    it("keeps the pinned AgentPit recipe on the shelf however the rotation moves", () => {
        const created = AUTOMATION_TEMPLATES.filter(t => !t.pinned)
            .slice(0, 3)
            .map(t => automationNamed(t.defaultName));
        renderShelf(created);
        expect(screen.getByText(AGENTPIT.label)).toBeTruthy();
    });

    it("drops it once the operator has added it, matched case-insensitively", () => {
        renderShelf([automationNamed(AGENTPIT.defaultName.toUpperCase())]);
        expect(screen.queryByText(AGENTPIT.label)).toBeNull();
    });

    it("still shows three recipes in all", () => {
        const {container} = renderShelf([]);
        expect(container.querySelectorAll("button")).toHaveLength(3);
    });
});
