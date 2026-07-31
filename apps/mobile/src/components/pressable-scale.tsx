import * as Haptics from 'expo-haptics';
import { forwardRef, useCallback } from 'react';
import {
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Asymmetric spring shape: snap quickly on touch (stiff, well-damped) and
// release with a small bounce (looser, slightly under-damped). Mirrors
// Material 3 Expressive's spring scheme and the iOS 26 press feel — the
// hand-off between visual change and the selection haptic feels "alive"
// instead of mechanical.
const PRESS_IN_SPRING = { mass: 0.6, damping: 18, stiffness: 420 } as const;
const PRESS_OUT_SPRING = { mass: 0.7, damping: 12, stiffness: 260 } as const;

interface PressableScaleProps extends Omit<PressableProps, 'style'> {
  /** Scale applied while finger is down. Default 0.95 — use ~0.94 for
   *  card-sized tiles and ~0.90 for small avatar-sized targets so the
   *  shrink is legible relative to the target. */
  pressedScale?: number;
  /** Opacity applied while finger is down. Default 0.9 — a touch of
   *  dimming pairs with the scale so the press reads on bright tiles
   *  even when the scale change is small. */
  pressedOpacity?: number;
  /** Whether to fire a selection haptic on press-in. iOS only; no-op
   *  on Android where the platform's own ripple covers it. */
  haptic?: boolean;
  /** Static style for the pressable. Function-form (the ``({ pressed })``
   *  callback) is intentionally not accepted — animation drives the
   *  press visual instead. */
  style?: PressableProps['style'] extends infer S
    ? S extends (...args: never[]) => unknown
      ? never
      : S
    : never;
}

/**
 * ``Pressable`` with spring-physics scale + opacity feedback and an
 * iOS selection haptic on touch.
 *
 * Designed to drop in wherever a ``Pressable`` is used today, including
 * inside expo-router's ``<Link asChild>`` — forwards refs and passes
 * the navigation ``onPress`` through unchanged.
 *
 * Press-down uses a stiff, well-damped spring (instant "snap"); release
 * uses a looser spring so the tile bounces back gently. The selection
 * haptic fires on press-in so the tactile and visual signals land
 * together, per iOS 26 / Material 3 Expressive guidance.
 */
export const PressableScale = forwardRef<View, PressableScaleProps>(
  function PressableScale(
    {
      children,
      pressedScale = 0.95,
      pressedOpacity = 0.9,
      haptic = true,
      onPressIn,
      onPressOut,
      style,
      ...rest
    },
    ref,
  ) {
    const scale = useSharedValue(1);
    const opacity = useSharedValue(1);

    const handlePressIn = useCallback(
      (e: GestureResponderEvent) => {
        scale.set(withSpring(pressedScale, PRESS_IN_SPRING));
        opacity.set(withSpring(pressedOpacity, PRESS_IN_SPRING));
        if (haptic && process.env.EXPO_OS === 'ios') {
          void Haptics.selectionAsync();
        }
        onPressIn?.(e);
      },
      [scale, opacity, pressedScale, pressedOpacity, haptic, onPressIn],
    );

    const handlePressOut = useCallback(
      (e: GestureResponderEvent) => {
        scale.set(withSpring(1, PRESS_OUT_SPRING));
        opacity.set(withSpring(1, PRESS_OUT_SPRING));
        onPressOut?.(e);
      },
      [scale, opacity, onPressOut],
    );

    const animatedStyle = useAnimatedStyle(() => ({
      opacity: opacity.get(),
      transform: [{ scale: scale.get() }],
    }));

    return (
      <AnimatedPressable
        ref={ref}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={[style, animatedStyle]}
        {...rest}>
        {children}
      </AnimatedPressable>
    );
  },
);
