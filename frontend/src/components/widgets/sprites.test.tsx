import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";

import { Sprite } from "./sprites";
import { setPieceSet } from "@/lib/pieceSet";

afterEach(() => {
  setPieceSet("sea");
});

describe("chess pieces", () => {
  it("draws the sea set until this device picks the classic one, and follows the pick at once", () => {
    const { container } = render(<Sprite name="chess.wN" />);
    expect(container.querySelector("img")?.getAttribute("src")).toContain("sea/wN");
    act(() => {
      setPieceSet("classic");
    });
    expect(container.querySelector("img")?.getAttribute("src")).toContain("classic/wN");
  });

  it("draws the set it is given, whatever the device picked, and a dot for a name it doesn't know", () => {
    setPieceSet("classic");
    const { container } = render(<Sprite name="chess.bK" set="sea" />);
    expect(container.querySelector("img")?.getAttribute("src")).toContain("sea/bK");
    const unknown = render(<Sprite name="checkers.man" />);
    expect(unknown.container.querySelector("svg circle")).not.toBeNull();
  });
});
