import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { frameEmailForDm } from "../src/email-dm-frame.js";

describe("frameEmailForDm", () => {
  it("blockquotes the whole frame so it stands apart from the agent's chat", () => {
    const out = frameEmailForDm({
      kind: "received",
      fromAddr: "owner@acme.com",
      subject: "Quarterly numbers",
      body: "Please send the latest figures.\nThanks.",
    });
    // Every line — header, metadata, body, and blank spacers — is quoted.
    for (const line of out.split("\n")) {
      assert.match(line, /^>/, `line not blockquoted: ${JSON.stringify(line)}`);
    }
    assert.match(out, /^> 📧 \*\*Email · received\*\*/);
    assert.match(out, /> \*\*From:\*\* owner@acme\.com/);
    assert.match(out, /> \*\*Subject:\*\* Quarterly numbers/);
    assert.match(out, /> Please send the latest figures\./);
    assert.match(out, /> Thanks\./);
  });

  it("labels each direction distinctly and omits From on outbound", () => {
    const reply = frameEmailForDm({ kind: "reply_sent", subject: "Re: Hi", body: "ok" });
    assert.match(reply, /Email · reply sent/);
    assert.doesNotMatch(reply, /From:/);

    const sent = frameEmailForDm({ kind: "sent", subject: "Hi", body: "ok" });
    assert.match(sent, /Email · sent/);
    assert.doesNotMatch(sent, /From:/);
  });

  it("falls back for an empty body and appends footer lines (e.g. attachments)", () => {
    const out = frameEmailForDm({
      kind: "received",
      fromAddr: "o@x",
      subject: "",
      body: "",
      footerLines: ["**Attachments:**", "- a.pdf (application/pdf): saved as inbound media"],
    });
    assert.match(out, /> \(no text body\)/);
    assert.match(out, /> \*\*Subject:\*\* \(no subject\)/);
    assert.match(out, /> \*\*Attachments:\*\*/);
    assert.match(out, /> - a\.pdf/);
  });
});
