import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';

import { useTheme } from '@/hooks/use-theme';

const FAB_SIZE = 44;

interface ScrollToBottomFabProps {
  onPress: () => void;
}

// Mount/unmount animations — used by the parent's conditional render so the
// chip appears to grow out of (and shrink back into) the composer row. We
// avoid an always-mounted opacity wrapper because animated opacity on a
// parent breaks UIVisualEffectView compositing on older iOS.
const FabEnter = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.6 }] },
  100: {
    opacity: 1,
    transform: [{ scale: 1 }],
    easing: Easing.out(Easing.back(1.6)),
  },
}).duration(220);

const FabExit = new Keyframe({
  0: { opacity: 1, transform: [{ scale: 1 }] },
  100: {
    opacity: 0,
    transform: [{ scale: 0.6 }],
    easing: Easing.in(Easing.cubic),
  },
}).duration(140);

export function ScrollToBottomFab({ onPress }: ScrollToBottomFabProps) {
  const theme = useTheme();
  return (
    <Animated.View entering={FabEnter} exiting={FabExit} style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Scroll to latest"
        onPress={() => {
          if (process.env.EXPO_OS === 'ios') {
            void Haptics.selectionAsync();
          }
          onPress();
        }}
        hitSlop={6}>
        <FabSurface>
          <SymbolView
            name={{ ios: 'arrow.down', android: 'arrow_downward' }}
            size={22}
            tintColor={theme.text}
            weight="semibold"
            style={styles.icon}
          />
        </FabSurface>
      </Pressable>
    </Animated.View>
  );
}

function FabSurface({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();

  if (process.env.EXPO_OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <GlassView
        glassEffectStyle="regular"
        isInteractive
        style={[styles.fabBase, style]}>
        {children}
      </GlassView>
    );
  }
  if (process.env.EXPO_OS === 'ios') {
    return (
      <BlurView
        tint="systemChromeMaterial"
        intensity={80}
        style={[styles.fabBase, style]}>
        {children}
      </BlurView>
    );
  }
  return (
    <View style={[styles.fabBase, { backgroundColor: theme.backgroundElement }, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fabBase: {
    alignItems: 'center',
    borderRadius: FAB_SIZE / 2,
    height: FAB_SIZE,
    justifyContent: 'center',
    overflow: 'hidden',
    width: FAB_SIZE,
  },
  icon: {
    height: 22,
    width: 22,
  },
  wrap: {
    // Center on the input row baseline — the composer row uses
    // ``alignItems: 'flex-end'`` so chips share a bottom edge.
    alignSelf: 'flex-end',
  },
});
