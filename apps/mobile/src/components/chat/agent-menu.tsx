import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { memo, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';

import { Avatar } from '@/components/avatar';
import { mentionToken } from '@/components/chat/mention-picker';
import { useTheme } from '@/hooks/use-theme';
import type { MmChannelMember } from '@/lib/api';

interface AgentMenuProps {
  members: MmChannelMember[];
  onPick: (member: MmChannelMember) => void;
}

const ROW_HEIGHT = 52;
const MAX_VISIBLE_ROWS = 6;

// Coordinated fade + scale + lift on enter / settle on exit. Origin is the
// lower-left of the panel (close to the robot trigger), so the menu reads as
// "growing out of" the button rather than appearing in place.
const MenuEnter = new Keyframe({
  0: {
    opacity: 0,
    transform: [{ translateY: 14 }, { scale: 0.9 }],
  },
  60: {
    opacity: 1,
    easing: Easing.out(Easing.cubic),
  },
  100: {
    opacity: 1,
    transform: [{ translateY: 0 }, { scale: 1 }],
    easing: Easing.out(Easing.back(1.4)),
  },
}).duration(260);

const MenuExit = new Keyframe({
  0: {
    opacity: 1,
    transform: [{ translateY: 0 }, { scale: 1 }],
  },
  100: {
    opacity: 0,
    transform: [{ translateY: 8 }, { scale: 0.94 }],
    easing: Easing.in(Easing.cubic),
  },
}).duration(160);

export const AgentMenu = memo(function AgentMenu({ members, onPick }: AgentMenuProps) {
  const theme = useTheme();
  if (members.length === 0) return null;

  const maxHeight = ROW_HEIGHT * Math.min(members.length, MAX_VISIBLE_ROWS) + 8;

  return (
    <Animated.View
      style={[styles.wrap, { transformOrigin: '12% 100%' }]}
      entering={MenuEnter}
      exiting={MenuExit}>
      <AgentSurface style={[styles.panel, { maxHeight }]}>
        <View style={styles.list}>
          {members.map((member) => {
            const token = mentionToken(member);
            const name = member.display_name ?? token;
            return (
              <Pressable
                key={token}
                accessibilityRole="button"
                accessibilityLabel={`Mention ${name}`}
                onPress={() => onPick(member)}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                <Avatar uri={member.avatar?.url} name={name} size={32} framed={false} />
                <View style={styles.rowBody}>
                  <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
                    {name}
                  </Text>
                  <Text
                    style={[styles.handle, { color: theme.textSecondary }]}
                    numberOfLines={1}>
                    @{token}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </AgentSurface>
    </Animated.View>
  );
});

function AgentSurface({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  if (process.env.EXPO_OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <GlassView glassEffectStyle="regular" style={[styles.surface, style]}>
        {children}
      </GlassView>
    );
  }
  if (process.env.EXPO_OS === 'ios') {
    return (
      <BlurView tint="systemChromeMaterial" intensity={80} style={[styles.surface, style]}>
        {children}
      </BlurView>
    );
  }
  return (
    <View style={[styles.surface, { backgroundColor: theme.backgroundElement }, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  handle: {
    fontSize: 12,
    marginTop: 1,
  },
  list: {
    paddingVertical: 4,
  },
  name: {
    fontSize: 15,
    fontWeight: '500',
  },
  panel: {
    overflow: 'hidden',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    height: ROW_HEIGHT,
    paddingHorizontal: 12,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowPressed: {
    opacity: 0.55,
  },
  surface: {
    borderRadius: 24,
  },
  wrap: {
    marginBottom: 2,
    marginHorizontal: 12,
  },
});
