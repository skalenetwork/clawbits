import { describe, expect, test } from "bun:test";
import {
  historyPosts,
  memberCountLabel,
  mergePost,
  orgName,
  reconcilePage,
  removePost,
  type History,
  type Post,
} from "./models";

const post = (
  id: number,
  message = "Hello",
  updated = "2026-09-14T10:00:00Z",
): Post => ({
  post_id: id,
  channel_id: "chat",
  human_id: 1,
  agent_id: null,
  poster_display_name: "Alex",
  message,
  status: "published",
  created_at: updated,
  updated_at: updated,
  files: [],
});
const history: History = {
  pages: [{ posts: [post(3), post(2)] }, { posts: [post(1)] }],
  pageParams: [null, 2],
};

describe("message reconciliation", () => {
  test("HTTP and SSE copies appear once in either arrival order", () => {
    const incoming = post(4);
    const result = mergePost(mergePost(history, incoming), incoming);
    expect(historyPosts(result).map((p) => p.post_id)).toEqual([1, 2, 3, 4]);
    expect(history.pages[0].posts).toHaveLength(2);
  });
  test("late create cannot overwrite a newer streaming update", () => {
    const result = mergePost(
      mergePost(history, post(4, "Complete", "2026-09-14T10:01:00Z")),
      post(4, "Partial"),
    );
    expect(historyPosts(result).at(-1)?.message).toBe("Complete");
  });
  test("updates replace posts in older pages", () => {
    expect(historyPosts(mergePost(history, post(1, "Edited")))[0].message).toBe(
      "Edited",
    );
  });
  test("streaming updates preserve untouched pages, messages, and cursors", () => {
    const original: History = {
      ...history,
      pages: [{ ...history.pages[0], next: 2 }, history.pages[1]],
    };
    const updated = mergePost(original, post(3, "Streaming"));
    expect(updated.pages[0].next).toBe(2);
    expect(updated.pages[0].posts[1]).toBe(original.pages[0].posts[1]);
    expect(updated.pages[1]).toBe(original.pages[1]);
    expect(updated.pageParams).toBe(original.pageParams);
  });
  test("duplicate and stale events leave the cache unchanged", () => {
    expect(mergePost(history, history.pages[0].posts[0])).toBe(history);
    expect(mergePost(history, post(3, "Old", "2026-09-13T10:00:00Z"))).toBe(
      history,
    );
    expect(removePost(history, 100)).toBe(history);
  });
  test("deletion preserves unaffected pages and the pagination cursor", () => {
    const original: History = {
      ...history,
      pages: [{ ...history.pages[0], next: 2 }, history.pages[1]],
    };
    const updated = removePost(original, 2);
    expect(updated.pages[0].next).toBe(2);
    expect(updated.pages[1]).toBe(original.pages[1]);
    expect(original.pages[0].posts).toHaveLength(2);
  });
  test("pagination overlap produces one stable ordered row", () => {
    expect(
      historyPosts({
        ...history,
        pages: [...history.pages, { posts: [post(1)] }],
      }),
    ).toHaveLength(3);
  });
  test("deletes remove all page copies", () => {
    expect(historyPosts(removePost(history, 2)).map((p) => p.post_id)).toEqual([
      1, 3,
    ]);
  });
  test("a snapshot cannot erase edits, creates, or deletes received during its fetch", () => {
    const before = [post(3), post(2), post(1)];
    const current = [post(4), post(3, "Edited"), before[2]];
    const result = reconcilePage({ posts: before }, before, current, true);
    expect(result.posts.map((p) => p.post_id)).toEqual([4, 3, 1]);
    expect(result.posts[1].message).toBe("Edited");
  });
  test("an older page does not absorb new live messages", () => {
    const before = [post(3)];
    const result = reconcilePage(
      { posts: [post(2), post(1)] },
      before,
      [post(4), ...before],
      false,
    );
    expect(result.posts.map((p) => p.post_id)).toEqual([2, 1]);
  });
  test("a late live update cannot replace a fresher server snapshot", () => {
    const before = [post(3)];
    const fetched = post(3, "Complete", "2026-09-14T10:02:00Z");
    const live = post(3, "Partial", "2026-09-14T10:01:00Z");
    const result = reconcilePage(
      { posts: [fetched], next: 2 },
      before,
      [live],
      true,
    );
    expect(result.posts[0]).toBe(fetched);
    expect(result.next).toBe(2);
  });
});

describe("workspace labels", () => {
  test("orgName prefers the display name", () => {
    expect(
      orgName({
        org_id: "org",
        name: "acme",
        display_name: "Acme",
        is_personal: false,
      }),
    ).toBe("Acme");
  });
  test("memberCountLabel is singular for one member", () => {
    expect(memberCountLabel(1)).toBe("1 member");
    expect(memberCountLabel(0)).toBe("0 members");
    expect(memberCountLabel(12)).toBe("12 members");
  });
});
