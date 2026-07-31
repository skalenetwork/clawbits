import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { StreamingMarkdown } from "./StreamingMarkdown";

// The word-blur prose tail splits text into per-word spans, so assert on the
// aggregate textContent rather than a single text node.
describe("StreamingMarkdown", () => {
  it("renders a plain-prose tail (word spans) without crashing", () => {
    const { container } = render(<StreamingMarkdown text="The quick brown fox" />);
    expect(container.textContent).toContain("The quick brown fox");
  });

  it("renders a finished block plus the actively-growing tail", () => {
    const { container } = render(
      <StreamingMarkdown text={"First paragraph.\n\nSecond one forming"} />,
    );
    expect(container.textContent).toContain("First paragraph.");
    expect(container.textContent).toContain("Second one forming");
  });

  it("renders a growing code fence as a plain block with its language", () => {
    const { container } = render(<StreamingMarkdown text={"```ts\nconst a = 1;"} />);
    expect(container.textContent).toContain("const a = 1;");
    expect(container.textContent).toContain("ts");
  });

  it("renders a structured (list) tail without crashing", () => {
    const { container } = render(<StreamingMarkdown text={"- item one\n- item two"} />);
    expect(container.textContent).toContain("item one");
    expect(container.textContent).toContain("item two");
  });

  it("survives a whitespace-only tail (caret-only, no crash)", () => {
    const { container } = render(<StreamingMarkdown text={"   "} />);
    expect(container).toBeInTheDocument();
  });
});
