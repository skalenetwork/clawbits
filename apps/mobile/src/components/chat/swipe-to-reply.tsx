import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { useTheme } from '@/hooks/use-theme';

const TRIGGER_PX = 60;
const MAX_PX = 90;
const REPLY_ICON_SIZE = 22;

interface SwipeToReplyProps {
  onReply: () => void;
  children: ReactNode;
}

/** Wraps a message bubble in a leftward pan gesture (finger moves from
 *  right toward left) that reveals a reply icon on the right edge and
 *  fires ``onReply`` when the user crosses the threshold.
 *
 *  Always-leftward avoids conflicting with the native swipe-from-left-edge
 *  back gesture, regardless of which side the bubble is anchored to. The
 *  same direction works for both incoming and outgoing messages — the
 *  reply icon sits in the right gutter the bubble vacates.
 *
 *  Uses ``failOffsetY`` so the vertical list scroll wins on diagonal
 *  drags, and ``activeOffsetX`` so a tap-and-hold (for the context menu)
 *  doesn't immediately translate the bubble. */
export function SwipeToReply({ onReply, children }: SwipeToReplyProps) {
  const theme = useTheme();
  const translateX = useSharedValue(0);
  const triggered = useSharedValue(false);

  const fireReply = () => {
    if (process.env.EXPO_OS === 'ios') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    onReply();
  };

  const buzzCrossing = () => {
    if (process.env.EXPO_OS === 'ios') {
      void Haptics.selectionAsync();
    }
  };

  // Watch for the bubble crossing the trigger distance — fire a haptic once
  // per gesture so the user "feels" the threshold land.
  useAnimatedReaction(
    () => translateX.get() <= -TRIGGER_PX,
    (now, prev) => {
      if (now && !prev) {
        triggered.set(true);
        runOnJS(buzzCrossing)();
      } else if (!now && prev) {
        triggered.set(false);
      }
    },
  );

  const gesture = Gesture.Pan()
    // Only activate after a clear leftward drag — leaves rightward swipes
    // (and the native left-edge back gesture) untouched.
    .activeOffsetX([-12, 9999])
    .failOffsetY([-12, 12])
    .onUpdate((e) => {
      'worklet';
      // Magnitude of leftward drag (positive number).
      const projected = -e.translationX;
      if (projected <= 0) {
        translateX.set(0);
        return;
      }
      const linear = Math.min(projected, MAX_PX);
      const overshoot = Math.max(0, projected - MAX_PX);
      const rubber = MAX_PX + Math.sqrt(overshoot) * 3;
      translateX.set(-(linear === MAX_PX ? rubber : linear));
    })
    .onEnd(() => {
      'worklet';
      if (translateX.get() <= -TRIGGER_PX) {
        runOnJS(fireReply)();
      }
      translateX.set(withSpring(0, { damping: 18, stiffness: 220, mass: 0.6 }));
    });

  const bubbleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.get() }],
  }));

  const iconStyle = useAnimatedStyle(() => {
    const progress = Math.min(-translateX.get() / TRIGGER_PX, 1);
    return {
      opacity: progress,
      transform: [{ scale: 0.6 + progress * 0.4 }],
    };
  });

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={styles.wrapper}>
        <Animated.View pointerEvents="none" style={[styles.iconSlot, iconStyle]}>
          <SymbolView
            name={{ ios: 'arrowshape.turn.up.left.fill', android: 'reply' }}
            size={REPLY_ICON_SIZE}
            tintColor={theme.textSecondary}
            weight="medium"
            style={styles.icon}
          />
        </Animated.View>
        <Animated.View style={[styles.bubbleSlot, bubbleStyle]}>
          {children}
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  // Both wrappers stretch to the full list row width — without an
  // explicit width here the chain collapses to intrinsic and the inner
  // bubble's ``maxWidth: '78%'`` has nothing definite to resolve against,
  // letting long messages overflow the screen on the right.
  wrapper: {
    alignSelf: 'stretch',
  },
  bubbleSlot: {
    alignSelf: 'stretch',
  },
  icon: {
    height: REPLY_ICON_SIZE,
    width: REPLY_ICON_SIZE,
  },
  iconSlot: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    position: 'absolute',
    right: 4,
    top: 0,
    width: 44,
  },
});
