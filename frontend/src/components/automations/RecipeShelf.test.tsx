import {describe, expect, it, vi} from "vitest";
import {render, screen} from "@testing-library/react";
import type {Automation} from "@/lib/api";
import {AUTOMATION_TEMPLATES} from "@/lib/automations";
import {RecipeShelf} from "./RecipeShelf";

const AGENTPIT = AUTOMATION_TEMPLATES.find(t => t.id === "agentpit-trading");
if (!AGENTPIT) throw new Error("the AgentPit recipe left the catalog");

function automationNamed(name: string): Automation {
    return {name} as Automation;
}

describe("RecipeShelf", () => {
    it("keeps the pinned AgentPit recipe on the shelf however the rotation moves", () => {
        // Every unpinned template ahead of it created — the old top-3 slice
        // would still have to reach past three fresh suggestions to show it.
        const created = AUTOMATION_TEMPLATES.filter(t => !t.pinned)
            .slice(0, 3)
            .map(t => automationNamed(t.defaultName));
        render(<RecipeShelf automations={created} onPick={vi.fn()}/>);
        expect(screen.getByText(AGENTPIT.label)).toBeTruthy();
    });

    it("drops it once the operator has added it", () => {
        render(
            <RecipeShelf
                // Matched case-insensitively, like every other recipe.
                automations={[automationNamed(AGENTPIT.defaultName.toUpperCase())]}
                onPick={vi.fn()}
            />,
        );
        expect(screen.queryByText(AGENTPIT.label)).toBeNull();
    });

    it("still shows three recipes in all", () => {
        const {container} = render(<RecipeShelf automations={[]} onPick={vi.fn()}/>);
        expect(container.querySelectorAll("button")).toHaveLength(3);
    });
});
