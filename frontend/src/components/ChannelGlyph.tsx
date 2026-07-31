import { Avatar } from "@/components/Avatar";
import { ChatAvatar } from "@/components/ChatAvatar";
import { Icon } from "@/components/Icon";
import {
    HashtagIcon as Hash,
    LockIcon as Lock,
} from "@hugeicons/core-free-icons";
import type { MmChannel } from "@/lib/api";
import {
    AGENT_AVATAR_SHAPE,
    CHANNEL_AVATAR_SHAPE,
    HUMAN_AVATAR_SHAPE,
    withSpeciesShape,
} from "@/lib/avatarShapes";

interface ChannelGlyphProps {
    channel: MmChannel;
    /** Size in px. Sizes ≤16px render the compact ``#`` / lock icon
     *  inline so it sits cleanly inside text runs. Larger sizes render
     *  the channel's generated avatar so each channel is visually
     *  distinct in lists and headers. */
    size?: number;
    /** Pass-through to ChatAvatar — suppress the top-right presence dot
     *  on DM avatars when a parent component is rendering its own
     *  presence indicator (e.g. the DM channel-page header pill). */
    showPresenceDot?: boolean;
    /** Extra classes for the avatar tile. A radius here overrides the
     *  species shape below (e.g. the mobile list's larger radii). Not
     *  applied to the ≤16px inline ``#``/lock icon variant. */
    className?: string;
}

/**
 * Visual prefix for a channel reference.
 *
 * - DMs delegate to :func:`ChatAvatar`, which stacks member avatars so
 *   you can recognise who you're talking to at a glance.
 * - Tile-sized public/private channels render their server-generated
 *   avatar (marble SVG keyed on ``channel_id``) — see ``clawbits.avatars``.
 * - Inline-sized (≤16px) public/private channels keep the legacy ``#``
 *   or lock icon since a coloured tile inside text would jar.
 *
 * **Species shape:** the silhouette tells the three species apart at a
 * glance — channels are sharp tiles (``rounded-sm``, structural), human
 * DMs are fully soft (``rounded-2xl``, ≈ circular at list sizes), and
 * agent DMs are human-round with one machined corner (``rounded-bl-sm``,
 * the "bot tail" — bottom-left so it stays clear of the bottom-right
 * presence dot). Group DMs take the human shape.
 */
export function ChannelGlyph({ channel, size = 16, showPresenceDot = true, className }: ChannelGlyphProps) {
    if (channel.channel_type === "direct") {
        const isAgentDm = Boolean(channel.dm_peer_agent_id);
        return (
            <ChatAvatar
                channelId={channel.channel_id}
                size={size}
                ringClassName="ring-sidebar-accent"
                showPresenceDot={showPresenceDot}
                className={withSpeciesShape(isAgentDm ? AGENT_AVATAR_SHAPE : HUMAN_AVATAR_SHAPE, className)}
            />
        );
    }
    if (size <= 16) {
        // Compact inline icon — preserves the Slack/Discord channel-type
        // signal where space is too tight for a coloured tile.
        const icon = channel.channel_type === "private" ? Lock : Hash;
        return <Icon icon={icon} className="shrink-0 text-muted-foreground"/>;
    }
    // Tile-sized: show the channel's distinct generated avatar. Falls
    // back to the initial-letter chip when the row pre-dates the
    // avatar backfill or the SVG fails to load.
    return (
        <Avatar
            src={channel.avatar?.url}
            name={channel.display_name ?? channel.name}
            size={size}
            className={withSpeciesShape(CHANNEL_AVATAR_SHAPE, className)}
        />
    );
}
