// Markdown framing for email activity mirrored into the operator DM channel.
//
// The agent authors these posts, so in the DM they share its name/avatar with
// ordinary chat replies. Wrapping the whole email in a blockquote (every line
// prefixed with "> ") is what visually distinguishes it: the agent's
// conversational replies are never quoted, so a quoted block reads instantly as
// email material rather than the agent talking in chat. The DM renders via
// markdown-it, so bold + blockquote (and its vertical bar) are honoured.
//
// TEMPORARY: this whole email->DM mirror is a stopgap; see callers in
// `email-adapter.ts` and `companion-tools.ts`.

export type EmailDmKind = "received" | "reply_sent" | "sent";

export interface EmailDmFrame {
  kind: EmailDmKind;
  /** Subject line, already `Re:`-prefixed by the caller when it's a reply. */
  subject: string;
  /** Plain-text email body. */
  body: string;
  /** Sender address; only shown for inbound (`received`) mail. */
  fromAddr?: string;
  /** Extra quoted lines appended after the body (e.g. an attachment summary). */
  footerLines?: string[];
}

const LABEL: Record<EmailDmKind, string> = {
  received: "📧 **Email · received**",
  reply_sent: "📧 **Email · reply sent**",
  sent: "📧 **Email · sent**",
};

/**
 * Build the blockquoted markdown block for one mirrored email. Every line is
 * prefixed with "> " (blank lines collapse to a bare ">") so the header,
 * metadata, and body render as a single quoted unit, set apart from the agent's
 * normal chat messages.
 */
export function frameEmailForDm(frame: EmailDmFrame): string {
  const lines: string[] = [LABEL[frame.kind]];
  if (frame.kind === "received" && frame.fromAddr) {
    lines.push(`**From:** ${frame.fromAddr}`);
  }
  lines.push(`**Subject:** ${frame.subject || "(no subject)"}`);
  lines.push("");
  const body = frame.body.trim().length > 0 ? frame.body : "(no text body)";
  lines.push(...body.split("\n"));
  if (frame.footerLines && frame.footerLines.length > 0) {
    lines.push("", ...frame.footerLines);
  }
  return lines.map((l) => (l.length > 0 ? `> ${l}` : ">")).join("\n");
}
