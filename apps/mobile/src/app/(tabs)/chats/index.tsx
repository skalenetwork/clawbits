import { ChannelListPane } from '@/components/chats/channel-list-pane';
import { EmptyDetailState } from '@/components/chats/empty-detail-state';
import { useIsLargeWindow } from '@/hooks/use-window-size-class';

/**
 *  At compact this screen IS the chats list, full width, with a Stack
 *  header above it. At ≥600dp the list moves to the left column of
 *  ``chats/_layout.tsx`` and this screen — now the right pane when no
 *  channel is selected — renders the friendly empty state.
 */
export default function ChatsScreen() {
  const isLarge = useIsLargeWindow();

  if (isLarge) return <EmptyDetailState />;

  return <ChannelListPane variant="screen" />;
}
