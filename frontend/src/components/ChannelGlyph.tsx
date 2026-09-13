import { useEffect } from "react";
import { HashtagIcon, LockIcon, Message01Icon } from "@hugeicons/core-free-icons";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { PresenceDot } from "@/components/PresenceDot";
import { UserAvatar } from "@/components/UserAvatar";
import { useAgentStatus } from "@/hooks/useAgentPresence";
import { seedMemberPresence, useUserStatus } from "@/hooks/useUserPresence";
import { agentStatusLabel } from "@/lib/agentLiveness";
import type { MmChannel, MmChannelMember } from "@/lib/api";
import {
    AGENT_AVATAR_SHAPE,
    CHANNEL_AVATAR_SHAPE,
    HUMAN_AVATAR_SHAPE,
    withSpeciesShape,
} from "@/lib/avatarShapes";
import { cn } from "@/lib/utils";

/** A channel's visual prefix: the DM peer's avatar, the channel's generated tile, or a `#` or lock icon at 16px and
 *  below. `className` styles the tile; a radius in it overrides the species shape. */
export function ChannelGlyph({ channel, size = 16, showPresenceDot = true, className }: {
    channel: MmChannel;
    size?: number;
    showPresenceDot?: boolean;
    className?: string;
}) {
    if (channel.channel_type === "direct") {
        return (
            <DmGlyph
                peer={channel.dm_peer}
                size={size}
                showPresenceDot={showPresenceDot}
                className={withSpeciesShape(channel.dm_peer_agent_id ? AGENT_AVATAR_SHAPE : HUMAN_AVATAR_SHAPE, className)}
            />
        );
    }
    if (size <= 16) {
        return <Icon icon={channel.channel_type === "private" ? LockIcon : HashtagIcon} className="shrink-0 text-muted-foreground"/>;
    }
    return (
        <Avatar
            src={channel.avatar?.url}
            name={channel.display_name ?? channel.name}
            size={size}
            className={withSpeciesShape(CHANNEL_AVATAR_SHAPE, className)}
        />
    );
}

function DmGlyph({ peer, size, showPresenceDot, className }: {
    peer: MmChannelMember | null | undefined;
    size: number;
    showPresenceDot: boolean;
    className: string;
}) {
    useEffect(() => {
        if (peer) seedMemberPresence([peer]);
    }, [peer]);

    const box = { width: size, height: size };
    // No border: under border-box it shrinks the content box and shifts the full-size avatar up and left.
    const frame = cn("relative shrink-0 overflow-hidden rounded-lg bg-muted", className);

    if (!peer) {
        return (
            <div className={cn(frame, "flex items-center justify-center text-muted-foreground")} style={box}>
                <Icon icon={Message01Icon} style={{ width: size * 0.8, height: size * 0.8 }}/>
            </div>
        );
    }

    return (
        <div className="relative shrink-0" style={box}>
            <div className={frame} style={box}>
                {peer.agent_id ? (
                    <AgentFaceAvatar
                        src={peer.avatar?.url}
                        size={size}
                        name={peer.display_name ?? peer.agent_id}
                        framed={false}
                        className="rounded-none"
                    />
                ) : (
                    <UserAvatar
                        size={size}
                        name={peer.human_id != null ? String(peer.human_id) : (peer.display_name ?? "user")}
                        src={peer.avatar?.url}
                        className="rounded-none"
                    />
                )}
            </div>
            {showPresenceDot && (peer.human_id != null || peer.agent_id != null) && <PeerDot peer={peer} size={size}/>}
        </div>
    );
}

function PeerDot({ peer, size }: { peer: MmChannelMember; size: number }) {
    const userStatus = useUserStatus(peer.human_id);
    const agentStatus = useAgentStatus(peer.agent_id);
    const isAgent = peer.agent_id != null;
    const label = isAgent ? agentStatusLabel(agentStatus) : userStatus;
    return (
        <span className="pointer-events-none absolute bottom-0 right-0" title={label}>
            <PresenceDot
                status={isAgent ? agentStatus : userStatus}
                size={Math.max(7, Math.round(size * 0.22))}
                ringClassName="ring-sidebar-accent"
                label={label}
            />
        </span>
    );
}
