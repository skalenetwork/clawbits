import {describe, expect, it} from "vitest";
import type {MmChannel, OrgMember} from "@/lib/api";
import {parseSearchQuery} from "./searchQuery";

const sources = {
    channels: [{channel_id: "c1", name: "design-team", display_name: "Design team", channel_type: "public", created_at: ""} as MmChannel],
    members: [{human_id: 7, email: "bob@x.io", display_name: "Bob Stone", role: "member"} as OrgMember],
    agents: [],
};

describe("parseSearchQuery", () => {
    it("resolves operators into filters and strips them from the text", () => {
        expect(parseSearchQuery("launch from:bob in:#design has:links after:2026-03", sources)).toEqual({
            text: "launch",
            filters: {fromHumanId: 7, channelId: "c1", hasLink: true, after: "2026-03-01"},
            chips: [
                {label: "from Bob Stone", token: "from:bob"},
                {label: "in Design team", token: "in:#design"},
                {label: "has link", token: "has:links"},
                {label: "after 2026-03-01", token: "after:2026-03"},
            ],
        });
    });

    it("keeps an unresolved name as a no-match chip without a filter", () => {
        expect(parseSearchQuery("from:nobdy", sources)).toEqual({
            text: "",
            filters: {},
            chips: [{label: "from: nobdy", token: "from:nobdy", unresolved: true}],
        });
    });

    it("drops a trailing operator that has no value yet", () => {
        expect(parseSearchQuery("launch from:", sources).text).toBe("launch");
        expect(parseSearchQuery("in:", sources).text).toBe("");
    });

    it("leaves invalid dates and unknown has: values in the text", () => {
        expect(parseSearchQuery("before:soon has:emoji", sources).text).toBe("before:soon has:emoji");
    });
});
