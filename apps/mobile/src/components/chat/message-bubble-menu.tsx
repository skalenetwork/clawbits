import * as Haptics from 'expo-haptics';
import { memo, useMemo, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
// eslint-disable-next-line import/no-unresolved -- ships as source-only; resolved at bundle time via the `react-native` package.json field.
import { ContextMenuView } from 'react-native-ios-context-menu';

import { MessageBubble } from '@/components/chat/message-bubble';
import { ReactionsRow } from '@/components/chat/reactions-row';
import { SwipeToReply } from '@/components/chat/swipe-to-reply';
import type { MessageRow } from '@/lib/chat-grouping';

export type BubbleAction = 'copy' | 'reply' | 'pin' | 'unpin' | 'edit' | 'delete' | 'retry';

const DOUBLE_TAP_EMOJI = '👍';

interface MessageBubbleMenuProps {
  row: MessageRow;
  onAction: (action: BubbleAction, postId: number) => void;
  onReact: (postId: number, emoji: string) => void;
  onImagePress?: (index: number, imageUrls: string[]) => void;
  /** Tap on a quoted parent — jumps to the referenced post. */
  onParentPress?: (parentPostId: number) => void;
  /** Briefly flash this bubble (search / jump landed on it). */
  highlighted?: boolean;
}

export const MessageBubbleMenu = memo(function MessageBubbleMenu({
  row,
  onAction,
  onReact,
  onImagePress,
  onParentPress,
  highlighted,
}: MessageBubbleMenuProps) {
  // Optimistic posts have a negative id: still in-flight (no server id to
  // act on yet) or failed (offer resend / discard via the (!) icon).
  const isPending = row.post.post_id < 0;
  const isFailed = row.post._failed === true;
  const swipeReply = () => onAction('reply', row.post.post_id);

  const bubble = (
    <MessageBubble
      row={row}
      onReactionPress={(emoji) => onReact(row.post.post_id, emoji)}
      onImagePress={onImagePress}
      onParentPress={onParentPress}
      onRetry={isFailed ? () => onAction('retry', row.post.post_id) : undefined}
      highlighted={highlighted}
    />
  );

  // Negative-id posts have no server id — skip every gesture overlay. A
  // failed post still gets its tappable (!) icon via ``onRetry`` above.
  if (isPending) return bubble;

  const tappableBubble = (
    <DoubleTapToReact
      onDoubleTap={() => onReact(row.post.post_id, DOUBLE_TAP_EMOJI)}>
      {bubble}
    </DoubleTapToReact>
  );

  // The iOS context-menu library is iOS-only; Android keeps swipe-to-reply
  // and the new double-tap-to-react, no long-press menu yet.
  if (Platform.OS !== 'ios') {
    return <SwipeToReply onReply={swipeReply}>{tappableBubble}</SwipeToReply>;
  }

  return (
    <SwipeToReply onReply={swipeReply}>
      <ContextMenuViewWrapper row={row} onAction={onAction} onReact={onReact}>
        {tappableBubble}
      </ContextMenuViewWrapper>
    </SwipeToReply>
  );
});

interface DoubleTapToReactProps {
  onDoubleTap: () => void;
  children: ReactNode;
}

/** Two quick taps anywhere on the bubble fire a 👍 reaction with a haptic.
 *  Single taps still flow through to inner Pressables (reactions, image
 *  grid, parent-quote) because the Tap gesture only completes on the
 *  second tap inside the window. */
function DoubleTapToReact({ onDoubleTap, children }: DoubleTapToReactProps) {
  const fire = () => {
    if (process.env.EXPO_OS === 'ios') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onDoubleTap();
  };

  const gesture = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .maxDelay(280)
        .onEnd((_event, success) => {
          'worklet';
          if (success) runOnJS(fire)();
        }),
    // `fire` closes over the latest `onDoubleTap`; re-creating the gesture
    // on every render is cheap and keeps the callback fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onDoubleTap],
  );

  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false}>{children}</View>
    </GestureDetector>
  );
}

interface ContextMenuViewWrapperProps {
  row: MessageRow;
  onAction: (action: BubbleAction, postId: number) => void;
  onReact: (postId: number, emoji: string) => void;
  children: ReactNode;
}

function ContextMenuViewWrapper({
  row,
  onAction,
  onReact,
  children,
}: ContextMenuViewWrapperProps) {
  const { post, isOutgoing } = row;
  const isPinned = post.pinned_at != null;

  const menuItems = useMemo(() => {
    const items: object[] = [
      {
        actionKey: 'reply',
        actionTitle: 'Reply',
        icon: {
          type: 'IMAGE_SYSTEM',
          imageValue: { systemName: 'arrowshape.turn.up.left' },
        },
      },
      {
        actionKey: 'copy',
        actionTitle: 'Copy',
        icon: { type: 'IMAGE_SYSTEM', imageValue: { systemName: 'doc.on.doc' } },
      },
      {
        actionKey: isPinned ? 'unpin' : 'pin',
        actionTitle: isPinned ? 'Unpin' : 'Pin',
        icon: {
          type: 'IMAGE_SYSTEM',
          imageValue: { systemName: isPinned ? 'pin.slash' : 'pin' },
        },
      },
    ];
    if (isOutgoing) {
      items.push({
        actionKey: 'edit',
        actionTitle: 'Edit',
        icon: { type: 'IMAGE_SYSTEM', imageValue: { systemName: 'pencil' } },
      });
      items.push({
        actionKey: 'delete',
        actionTitle: 'Delete',
        menuAttributes: ['destructive'],
        icon: { type: 'IMAGE_SYSTEM', imageValue: { systemName: 'trash' } },
      });
    }
    return items;
  }, [isOutgoing, isPinned]);

  return (
    <ContextMenuView
      menuConfig={{ menuTitle: '', menuItems: menuItems as never }}
      // `previewConfig` left at the library defaults so iOS uses
      // `UIContextMenuInteraction`'s native preview — that's what
      // gives us the system blur backdrop dimming the rest of the
      // chat when the bubble is long-pressed.
      isAuxiliaryPreviewEnabled
      auxiliaryPreviewConfig={{
        // Use the *new* (non-deprecated) config schema only — mixing
        // in `marginPreview` from the deprecated schema confused the
        // native parser and the auxiliary preview never rendered.
        verticalAnchorPosition: 'automatic',
        horizontalAlignment: isOutgoing ? 'targetTrailing' : 'targetLeading',
        // Constant dimensions match the ReactionsRow pill (5 × 40px
        // buttons + 4px horizontal padding ≈ 208 wide; 40 button +
        // 4×2 vertical padding = 48 tall) so the native overlay has
        // explicit hit/draw rects instead of relying on intrinsic
        // size from the wrapper view.
        preferredWidth: { mode: 'constant', value: 220 },
        preferredHeight: { mode: 'constant', value: 48 },
        marginVerticalInner: 10,
        marginVerticalOuter: 10,
        transitionConfigEntrance: {
          mode: 'syncedToMenuEntranceTransition',
          shouldAnimateSize: true,
        },
        transitionExitPreset: { mode: 'zoomAndSlide' },
      }}
      renderAuxiliaryPreview={() => (
        <ReactionsRow
          onPick={(emoji) => {
            onReact(post.post_id, emoji);
          }}
        />
      )}
      onPressMenuItem={({ nativeEvent }) => {
        onAction(nativeEvent.actionKey as BubbleAction, post.post_id);
      }}>
      {children}
    </ContextMenuView>
  );
}
