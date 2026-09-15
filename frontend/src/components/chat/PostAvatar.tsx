import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { UserAvatar } from "@/components/UserAvatar";
import type { MmChannelPost } from "@/lib/api";
import { posterName } from "@/lib/messageHelpers";

export function PostAvatar({ post, size }: { post: MmChannelPost; size: number }) {
  return (
    <span className="relative inline-flex shrink-0">
      {post.human_id != null && !post.agent_id ? (
        <UserAvatar size={size} name={post.poster_display_name ?? String(post.human_id)} src={post.avatar?.url} />
      ) : (
        <AgentFaceAvatar size={size} name={posterName(post)} src={post.avatar?.url} />
      )}
    </span>
  );
}
