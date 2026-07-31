import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "../src/email-html.js";

describe("htmlToText", () => {
  it("strips tags and keeps readable prose", () => {
    assert.equal(htmlToText("<p>Hello <b>world</b></p>"), "Hello world");
  });

  it("turns <br> and block boundaries into newlines", () => {
    assert.equal(htmlToText("Line one<br>Line two"), "Line one\nLine two");
    assert.equal(htmlToText("<p>A</p><p>B</p>"), "A\nB");
  });

  it("drops script/style/comment blocks entirely", () => {
    const html = "<style>.x{color:red}</style><p>Visible</p><script>alert(1)</script><!-- hi -->";
    assert.equal(htmlToText(html), "Visible");
  });

  it("decodes named and numeric entities", () => {
    assert.equal(htmlToText("a &amp; b &lt;c&gt; &#39;d&#39; &#x41;"), "a & b <c> 'd' A");
    assert.equal(htmlToText("x&nbsp;y"), "x y");
  });

  it("collapses excess whitespace and trims", () => {
    assert.equal(htmlToText("  <p>  a   b  </p>\n\n\n<p>c</p>  "), "a b\n\nc");
  });

  it("returns empty string for empty/whitespace input", () => {
    assert.equal(htmlToText(""), "");
    assert.equal(htmlToText("   \n  "), "");
  });
});
