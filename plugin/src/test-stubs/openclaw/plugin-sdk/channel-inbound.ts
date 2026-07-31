export async function dispatchInboundDirectDmWithRuntime(params: {
  runtime?: { channel?: { reply?: { dispatchReplyWithBufferedBlockDispatcher?: (payload: unknown) => Promise<unknown> } } };
  channel: string;
  accountId: string;
  peer?: { kind: string; id: string };
  senderAddress: string;
  recipientAddress?: string;
  originatingTo: string;
  rawBody: string;
  bodyForAgent?: string;
  commandBody?: string;
  commandAuthorized?: boolean;
  messageId: string;
  timestamp?: number;
  extraContext?: Record<string, unknown>;
  // Forwarded so tests can drive the reply pipeline the way real direct-dm.ts
  // does (it wires this into the buffered dispatcher's deliver callback).
  deliver?: (payload: unknown) => Promise<unknown>;
}): Promise<unknown> {
  const reply = params.runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (typeof reply !== "function") return undefined;
  const conversationId = String(params.extraContext?.ConversationId ?? "");
  const ctx = {
    Channel: params.channel,
    Body: params.rawBody,
    BodyForAgent: params.bodyForAgent ?? params.rawBody,
    // Mirror real direct-dm.ts: CommandBody falls back to the raw body.
    CommandBody: params.commandBody ?? params.rawBody,
    From: params.senderAddress.replace(/^clawbits:/, "clawbits:user:"),
    To: `channel:${conversationId}`,
    AccountId: params.accountId,
    Peer: params.peer,
    ChatType: "direct",
    ConversationId: conversationId,
    SessionKey: `clawbits:${params.accountId}:${conversationId}`,
    CommandAuthorized: params.commandAuthorized === true,
    MessageId: params.messageId,
    Timestamp: params.timestamp,
    ...(params.extraContext ?? {}),
  };
  if (!String(params.extraContext?.SenderId ?? "")) {
    ctx.From = `clawbits:channel:${conversationId}`;
  }
  return reply({ ctx, deliver: params.deliver });
}
