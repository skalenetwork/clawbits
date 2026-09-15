import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { listMmChannelPosts, listPinnedMmPosts, pinMmPost, unpinMmPost, type MmChannelPost } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";

type PostsPage = Awaited<ReturnType<typeof listMmChannelPosts>>;

/** A channel's pinned posts; the header pill and the pinned panel share this cache. */
export function usePinnedPosts(channelId: string) {
  return useQuery({
    queryKey: queryKeys.mm.channelPinnedPosts(channelId),
    queryFn: () => listPinnedMmPosts(channelId),
    staleTime: 30_000,
  });
}

/** Toggle pin/unpin on a channel post. Optimistically flips ``pinned_at`` in
 *  the first posts page so the pill and the message header update instantly;
 *  the pinned list refetches on success. */
export function usePinToggle(channelId: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const postsKey = queryKeys.mm.channelPosts(channelId, 50, 0);
  return useMutation({
    mutationFn: (post: MmChannelPost) =>
      post.pinned_at != null ? unpinMmPost(post.post_id) : pinMmPost(post.post_id),
    onMutate: async (post) => {
      await queryClient.cancelQueries({ queryKey: postsKey });
      const prev = queryClient.getQueryData<PostsPage>(postsKey);
      if (!prev || user == null) return { prev };
      const willPin = post.pinned_at == null;
      queryClient.setQueryData<PostsPage>(postsKey, {
        ...prev,
        posts: prev.posts.map((p) =>
          p.post_id === post.post_id
            ? {
                ...p,
                pinned_at: willPin ? new Date().toISOString() : null,
                pinned_by_human_id: willPin ? user.id : null,
              }
            : p,
        ),
      });
      return { prev };
    },
    onError: (err, _post, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(postsKey, ctx.prev);
      toast.error(errMsg(err, "Couldn't update pin"));
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<PostsPage>(postsKey, (prev) =>
        prev
          ? { ...prev, posts: prev.posts.map((p) => (p.post_id === updated.post_id ? updated : p)) }
          : prev,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.mm.channelPinnedPosts(channelId) });
      toast.success(updated.pinned_at != null ? "Pinned to channel" : "Unpinned");
    },
  });
}
