import { LinearGradient } from 'expo-linear-gradient';
import { router, Stack } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import { openBrowserAsync } from 'expo-web-browser';
import type { ReactNode } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { SFSymbol } from 'sf-symbols-typescript';

import { DangerPill } from '@/components/danger-pill';
import { MaxWidthContent } from '@/components/max-width-content';
import { SignInEmptyState } from '@/components/sign-in-empty-state';
import { useTheme } from '@/hooks/use-theme';
import { darken, lighten, withAlpha } from '@/lib/color-utils';
import { apiBaseUrl } from '@/lib/config';
import { useAuth } from '@/providers/auth-provider';

const X_HANDLE = 'clawbitsai';
const X_APP_URL = `twitter://user?screen_name=${X_HANDLE}`;
const X_WEB_URL = `https://x.com/${X_HANDLE}`;

/** Open the X profile in the native X (formerly Twitter) app if it's
 *  installed, otherwise fall back to the in-app browser. The X iOS app
 *  still ships the legacy ``twitter://`` URL scheme — checking it with
 *  ``Linking.canOpenURL`` requires the scheme to be listed in
 *  ``LSApplicationQueriesSchemes`` (see app.json). */
async function openXProfile() {
  try {
    if (await Linking.canOpenURL(X_APP_URL)) {
      await Linking.openURL(X_APP_URL);
      return;
    }
  } catch {
    // Fall through to the web fallback below.
  }
  await openBrowserAsync(X_WEB_URL);
}

const CHEVRON_COLOR = '#8E8E93';

// iOS Settings-style tile colors — saturated bases that pair well with the
// glossy gradient overlay applied inside ``IconTile``. Picked to match the
// system palette so the screen reads as native iOS.
const TILE_GRAY = '#8E8E93';
const TILE_BLUE = '#0A84FF';
const TILE_GREEN = '#30D158';
const TILE_RED = '#FF453A';
const TILE_PINK = '#FF2D55';
const TILE_PURPLE = '#5856D6';
const TILE_BLACK = '#1C1C1E';

const ICON_SIZE = 30;
// iOS 26 uses a slightly more pronounced squircle on small tiles — ~8pt on
// a 30pt icon reads as the continuous-curvature corner Apple ships.
const ICON_RADIUS = 8;
// iOS 26 grouped-list sections jumped to a much rounder corner (~22pt) to
// pair with the liquid-glass UI language.
const SECTION_RADIUS = 22;

type Symbol = { ios: SFSymbol; android: AndroidSymbol };

/** Glossy app-icon-style tile: rounded square with a subtle top-highlight
 *  gradient, a color-matched darker rim for depth, and a centered white
 *  glyph (SF Symbol by default, or a custom ``glyph`` node — used for the
 *  X brand logo, which has no SF Symbol). Matches the iOS Settings look. */
function IconTile({
  symbol,
  color,
  glyph,
}: {
  symbol?: Symbol;
  color: string;
  glyph?: ReactNode;
}) {
  return (
    <LinearGradient
      colors={[lighten(color, 0.16), color]}
      start={{ x: 0.5, y: 0 }}
      end={{ x: 0.5, y: 1 }}
      style={[styles.tile, { borderColor: withAlpha(darken(color, 0.35), 0.15) }]}>
      {glyph ?? (
        symbol ? (
          <SymbolView name={symbol} tintColor="#ffffff" size={18} style={styles.tileSymbol} />
        ) : null
      )}
    </LinearGradient>
  );
}

/** Brand X logo (the post-Twitter mark). Public viewBox is 1200×1227 — the
 *  asymmetric height is intentional and matches every download from
 *  ``about.x.com/en/brand-toolkit``. Rendered in white inside the tile so
 *  it visually matches the other SF-symbol glyphs. */
function XLogo({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 1200 1227">
      <Path
        fill="#ffffff"
        d="M714.163 519.284 1160.89 0H1055.03L667.137 450.887 357.328 0H0L468.492 681.821 0 1226.37H105.866L515.491 750.218 842.672 1226.37H1200L714.137 519.284h.026ZM569.165 687.828l-47.468-67.894-377.686-540.24h162.604l304.797 435.991 47.468 67.894 396.2 566.721H892.476L569.165 687.854v-.026Z"
      />
    </Svg>
  );
}

function Chevron() {
  return (
    <SymbolView
      name={{ ios: 'chevron.forward', android: 'chevron_right' }}
      tintColor={CHEVRON_COLOR}
      size={14}
      weight="semibold"
    />
  );
}

function ExternalArrow() {
  return (
    <SymbolView
      name={{ ios: 'arrow.up.right', android: 'north_east' }}
      tintColor={CHEVRON_COLOR}
      size={14}
      weight="semibold"
    />
  );
}

function SectionHeader({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <Text style={[styles.sectionHeader, { color: theme.textSecondary }]}>{children}</Text>
  );
}

function Section({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.section, { backgroundColor: theme.backgroundElement }, style]}>
      {children}
    </View>
  );
}

interface RowProps {
  leading: ReactNode;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  /** When true, hide the bottom hairline (last row in a section). */
  isLast?: boolean;
}

function Row({ leading, title, subtitle, trailing, onPress, isLast }: RowProps) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <View style={styles.rowLeading}>{leading}</View>
      <View style={[styles.rowBody, !isLast && { borderBottomColor: theme.backgroundSelected, borderBottomWidth: StyleSheet.hairlineWidth }]}>
        <View style={styles.rowText}>
          <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text
              style={[styles.rowSubtitle, { color: theme.textSecondary }]}
              numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {trailing ? <View style={styles.rowTrailing}>{trailing}</View> : null}
      </View>
    </Pressable>
  );
}

function SettingsTitle() {
  const theme = useTheme();
  return (
    <View style={styles.titleSlot}>
      <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
        Settings
      </Text>
    </View>
  );
}

export default function SettingsScreen() {
  const theme = useTheme();
  const { signOut, status, user } = useAuth();
  const headerHeight = useHeaderHeight();
  const androidHeaderPad = Platform.OS === 'android' ? headerHeight : 0;

  // Sign-out clears the keychain token and the entire persisted query cache,
  // so guard the one-tap nav-bar button behind a destructive confirmation.
  const confirmSignOut = () => {
    Alert.alert('Sign out?', 'You can sign back in anytime.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => void signOut() },
    ]);
  };

  if (status === 'anonymous') {
    return (
      <>
        <Stack.Screen
          options={{
            headerTitle: () => <SettingsTitle />,
            // Stack.Screen options merge across renders, so the
            // authenticated branch's sign-out button would otherwise
            // stick around after sign-out. Render an empty slot to
            // clear it.
            headerRight: () => null,
          }}
        />
        <View
        key={`screen-${status}`}
        style={[styles.screen, { backgroundColor: theme.background }]}>
          <SignInEmptyState
            symbol={{ ios: 'person.crop.circle', android: 'account_circle' }}
            title="Sign in to Clawbits"
            subtitle="Manage your account, workspaces, and preferences."
          />
        </View>
      </>
    );
  }

  const displayName = user?.display_name?.trim() || user?.email || 'Your profile';

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => <SettingsTitle />,
          headerRight: () => (
            <DangerPill
              symbol={{
                ios: 'rectangle.portrait.and.arrow.right.fill',
                android: 'logout',
              }}
              accessibilityLabel="Sign out"
              onPress={confirmSignOut}
            />
          ),
        }}
      />
      <View
        key={`screen-${status}`}
        style={[styles.screen, { backgroundColor: theme.background }]}>
        <MaxWidthContent maxWidth={720}>
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: androidHeaderPad + 12 },
          ]}
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}>
          <Section>
            <Row
              leading={<IconTile symbol={{ ios: 'person.fill', android: 'person' }} color={TILE_PURPLE} />}
              title={displayName}
              subtitle="View profile"
              trailing={<Chevron />}
              onPress={() => router.push('/(tabs)/settings/profile')}
              isLast
            />
          </Section>

          <Section>
            <Row
              leading={
                <IconTile
                  symbol={{ ios: 'building.2.fill', android: 'apartment' }}
                  color={TILE_BLUE}
                />
              }
              title="Workspaces"
              trailing={<Chevron />}
              onPress={() => router.push('/(tabs)/settings/workspaces')}
              isLast
            />
          </Section>

          <SectionHeader>Preferences</SectionHeader>
          <Section>
            <Row
              leading={
                <IconTile
                  symbol={{ ios: 'bell.fill', android: 'notifications' }}
                  color={TILE_RED}
                />
              }
              title="Notifications"
              subtitle="Manage in iOS Settings"
              trailing={<ExternalArrow />}
              onPress={() => void Linking.openSettings()}
            />
            <Row
              leading={
                <IconTile
                  symbol={{ ios: 'paintpalette.fill', android: 'palette' }}
                  color={TILE_PINK}
                />
              }
              title="Appearance"
              trailing={<Chevron />}
              onPress={() => router.push('/(tabs)/settings/appearance')}
              isLast
            />
          </Section>

          <SectionHeader>Resources</SectionHeader>
          <Section>
            <Row
              leading={
                <IconTile
                  symbol={{ ios: 'envelope.fill', android: 'mail' }}
                  color={TILE_BLUE}
                />
              }
              title="Contact support"
              trailing={<ExternalArrow />}
              onPress={() => void Linking.openURL('mailto:support@clawbits.ai')}
            />
            <Row
              leading={<IconTile color={TILE_BLACK} glyph={<XLogo />} />}
              title="Clawbits on X"
              trailing={<ExternalArrow />}
              onPress={() => void openXProfile()}
              isLast
            />
          </Section>

          <SectionHeader>Legal</SectionHeader>
          <Section>
            <Row
              leading={
                <IconTile
                  symbol={{ ios: 'doc.text.fill', android: 'description' }}
                  color={TILE_GRAY}
                />
              }
              title="Terms of service"
              trailing={<ExternalArrow />}
              onPress={() => void openBrowserAsync('https://clawbits.ai/terms')}
            />
            <Row
              leading={
                <IconTile
                  symbol={{ ios: 'hand.raised.fill', android: 'privacy_tip' }}
                  color={TILE_GREEN}
                />
              }
              title="Privacy policy"
              trailing={<ExternalArrow />}
              onPress={() => void openBrowserAsync('https://clawbits.ai/privacy')}
              isLast
            />
          </Section>

          {__DEV__ ? (
            <>
              <SectionHeader>Developer</SectionHeader>
              <Section>
                <Row
                  leading={
                    <IconTile
                      symbol={{
                        ios: 'antenna.radiowaves.left.and.right',
                        android: 'wifi_tethering',
                      }}
                      color={TILE_PURPLE}
                    />
                  }
                  title="API"
                  subtitle={apiBaseUrl}
                  isLast
                />
              </Section>
            </>
          ) : null}
        </ScrollView>
        </MaxWidthContent>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingLeft: 16,
  },
  rowBody: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    minHeight: 52,
    paddingRight: 14,
    paddingVertical: 8,
  },
  rowLeading: {
    alignItems: 'center',
    height: 52,
    justifyContent: 'center',
    marginRight: 12,
    width: ICON_SIZE,
  },
  rowPressed: {
    opacity: 0.6,
  },
  rowSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 17,
    fontWeight: '400',
    letterSpacing: -0.2,
  },
  rowTrailing: {
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  screen: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 96,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  section: {
    borderRadius: SECTION_RADIUS,
    marginBottom: 24,
    overflow: 'hidden',
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: -0.1,
    marginBottom: 8,
    marginLeft: 4,
    marginTop: -8,
  },
  tile: {
    alignItems: 'center',
    // Hairline rim with very low alpha so it reads as a soft edge
    // highlight rather than a hard outline against the tile gradient.
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: ICON_RADIUS,
    height: ICON_SIZE,
    justifyContent: 'center',
    overflow: 'hidden',
    width: ICON_SIZE,
  },
  tileSymbol: {
    height: 18,
    width: 18,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  titleSlot: {
    alignItems: 'flex-start',
    flex: 1,
    width: '100%',
  },
});
