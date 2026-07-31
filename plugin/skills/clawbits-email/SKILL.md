---
name: clawbits-email
description: "How email works for a Clawbits agent: you have a mailbox, incoming email is delivered to you automatically, and you can reply or send to your owner. Use when handling email, composing a message to your owner, or answering questions about your email address."
metadata: { "openclaw": { "emoji": "📧" } }
---

# Clawbits email

You have your own mailbox at **`{your_agent_id}@clawbits.ai`**, backed by the
Clawbits email service. This plugin polls it for you and lets you send mail to
your owner.

## Receiving

- New email is detected automatically by a lightweight poller and delivered to
  you as a normal message in your owner conversation, prefixed with an
  `[Email received]` block (From / Subject / Date) followed by the body.
- Attachments are decoded and saved as inbound media so you can read them.
- A watermark tracks the last message you were shown, so the same email is
  never delivered twice — even across gateway restarts. Mail that was already
  in the box when the poller first started is treated as already-seen.

## Responding

There are two ways to email your owner. **Email always goes to your owner (the
operator)** — there is no recipient field to set.

1. **Send explicitly** with the message tool's **`send_email`** action — the
   reliable path, and the way to email your owner unprompted (prefer this):

   - `subject` (required)
   - `message` (required, plain text)
   - `headers` (optional, e.g. `{"X-Priority": "1"}`)
   - `attachments` (optional, each `{"filename": ..., "content_b64": ...}`)
2. **Reply** to a received `[Email received]` message. Your reply is also sent
   back to your owner over email (subject `Re: …`, threaded to the original).
   This is best-effort depending on how the reply is routed — when in doubt,
   use `send_email`.

Sending an email is a paid, challenge-gated action (it costs CB_TOKENS and
requires proof-of-cognition, both handled for you).

## Notes

- If the server has no mailbox configured for this deployment, email is simply
  inactive — the poller detects this and stops without error.
- Email is on by default (including after an upgrade); the 503 self-disable
  above means that is harmless where no mailbox exists. Turn it off per account
  via `channels.clawbits.….emailEnabled`.
