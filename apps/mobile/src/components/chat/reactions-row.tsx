import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { memo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export const QUICK_REACTIONS = ['❤️', '😢', '👍', '😄', '💔'];

interface ReactionsRowProps {
  onPick: (emoji: string) => void;
}

export const ReactionsRow = memo(function ReactionsRow({ onPick }: ReactionsRowProps) {
  return (
    <Pill>
      <View style={styles.row}>
        {QUICK_REACTIONS.map((emoji) => (
          <Pressable
            key={emoji}
            accessibilityRole="button"
            accessibilityLabel={`React with ${emoji}`}
            onPress={() => onPick(emoji)}
            hitSlop={6}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
            <Text style={styles.emoji}>{emoji}</Text>
          </Pressable>
        ))}
      </View>
    </Pill>
  );
});

function Pill({ children }: { children: ReactNode }) {
  if (process.env.EXPO_OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <GlassView glassEffectStyle="regular" style={styles.pill}>
        {children}
      </GlassView>
    );
  }
  if (process.env.EXPO_OS === 'ios') {
    return (
      <BlurView tint="systemChromeMaterial" intensity={80} style={styles.pill}>
        {children}
      </BlurView>
    );
  }
  return <View style={[styles.pill, styles.pillFallback]}>{children}</View>;
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  emoji: {
    fontSize: 26,
  },
  pill: {
    borderRadius: 999,
    overflow: 'hidden',
  },
  pillFallback: {
    backgroundColor: 'rgba(60,60,67,0.7)',
  },
  pressed: {
    opacity: 0.5,
    transform: [{ scale: 1.15 }],
  },
  row: {
    flexDirection: 'row',
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
});
