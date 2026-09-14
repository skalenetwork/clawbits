import { createContext } from "react";
import type { MmChannel, MmChannelMember } from "@/lib/api";

export interface MessageMentions {
  memberByToken: ReadonlyMap<string, MmChannelMember>;
  channelsByToken: ReadonlyMap<string, MmChannel>;
  currentUserChannelIds: ReadonlySet<string>;
}

export const MentionsContext = createContext<MessageMentions | null>(null);

/** Splits text so odd indices are @mention or #channel tokens; the lookbehind keeps URL fragments out. */
export const MENTION_TOKEN_RE = /(@[A-Za-z0-9_.-]+|(?<![A-Za-z0-9_./-])#[A-Za-z0-9_.-]+)/;
