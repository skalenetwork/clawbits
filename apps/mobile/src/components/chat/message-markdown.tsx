import { openBrowserAsync } from 'expo-web-browser';
import { memo, useMemo, type ReactNode } from 'react';
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import {
  Renderer,
  useMarkdown,
  type MarkedStyles,
  type RendererInterface,
} from 'react-native-marked';

import { useColorScheme } from '@/hooks/use-color-scheme';

const MENTION_RE = /@[A-Za-z0-9_-]+/g;

interface MessageMarkdownProps {
  text: string;
  /** Foreground color of the bubble's text. */
  color: string;
  /** Background-tone for inline code / code blocks. */
  codeBackground: string;
  /** Color for tapped links. iMessage uses bright blue on both bubble colors. */
  linkColor: string;
}

const EMOJI_ONLY_RE = /^(\s|\p{Emoji_Presentation}|\p{Extended_Pictographic}|️|‍)+$/u;

/**
 * Renders markdown inside a chat bubble:
 *   - GFM (autolinks, strikethrough, tables) via marked's defaults
 *   - Custom link renderer opens in expo-web-browser
 *   - Jumbo size when the entire message is emoji-only
 *   - Default paragraph margins zeroed so the bubble doesn't grow
 */
export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  color,
  codeBackground,
  linkColor,
}: MessageMarkdownProps) {
  const scheme = useColorScheme();
  const isJumbo = EMOJI_ONLY_RE.test(text.trim());

  const styleObj: MarkedStyles = useMemo(
    () => ({
      text: { color, fontSize: 17, letterSpacing: -0.2, lineHeight: 22 },
      em: { fontStyle: 'italic' },
      strong: { fontWeight: '600' },
      strikethrough: { textDecorationLine: 'line-through' },
      link: { color: linkColor, textDecorationLine: 'underline' },
      paragraph: { marginVertical: 0, paddingVertical: 0 } as ViewStyle,
      blockquote: {
        borderLeftWidth: 3,
        borderLeftColor: codeBackground,
        marginVertical: 2,
        paddingLeft: 8,
      } as ViewStyle,
      code: {
        backgroundColor: codeBackground,
        borderRadius: 8,
        marginVertical: 4,
        padding: 8,
      } as ViewStyle,
      codespan: {
        backgroundColor: codeBackground,
        borderRadius: 4,
        color,
        fontFamily: 'Menlo',
        fontSize: 15,
        paddingHorizontal: 4,
      } as TextStyle,
      list: { marginVertical: 0 } as ViewStyle,
      li: { color, fontSize: 17, lineHeight: 22 },
      h1: { color, fontSize: 22, fontWeight: '700', marginVertical: 2, paddingBottom: 0, borderBottomWidth: 0 },
      h2: { color, fontSize: 20, fontWeight: '700', marginVertical: 2, paddingBottom: 0, borderBottomWidth: 0 },
      h3: { color, fontSize: 18, fontWeight: '700', marginVertical: 2 },
      h4: { color, fontSize: 17, fontWeight: '700', marginVertical: 2 },
      h5: { color, fontSize: 16, fontWeight: '700', marginVertical: 2 },
      h6: { color, fontSize: 15, fontWeight: '700', marginVertical: 2 },
    }),
    [color, codeBackground, linkColor],
  );

  const renderer = useMemo(() => new BubbleRenderer(linkColor), [linkColor]);
  const nodes = useMarkdown(text, {
    colorScheme: scheme === 'dark' ? 'dark' : 'light',
    styles: styleObj,
    renderer,
  });

  if (isJumbo) {
    return <Text style={[styles.jumbo, { color }]}>{text}</Text>;
  }

  return <View style={styles.wrap}>{nodes}</View>;
});

class BubbleRenderer extends Renderer implements RendererInterface {
  private linkColor: string;
  constructor(linkColor: string) {
    super();
    this.linkColor = linkColor;
  }
  link(children: string | ReactNode[], href: string, styles?: TextStyle): ReactNode {
    // Inline <Text onPress> instead of <Pressable> so the link flows with
    // surrounding text rather than breaking out as a block element — fixes
    // links rendered on their own line next to a mention/word.
    return (
      <Text
        key={`link-${href}`}
        onPress={() => {
          void openBrowserAsync(href).catch(() => {});
        }}
        style={[styles, { color: this.linkColor, fontStyle: 'normal', textDecorationLine: 'underline' }]}>
        {children}
      </Text>
    );
  }
  text(text: string, styles?: TextStyle): ReactNode {
    if (!MENTION_RE.test(text)) {
      return super.text(text, styles);
    }
    MENTION_RE.lastIndex = 0;
    const segments: ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MENTION_RE.exec(text)) !== null) {
      if (match.index > lastIndex) {
        segments.push(text.slice(lastIndex, match.index));
      }
      segments.push(
        <Text
          key={`mention-${String(match.index)}`}
          style={{ color: this.linkColor, fontWeight: '600' }}>
          {match[0]}
        </Text>,
      );
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      segments.push(text.slice(lastIndex));
    }
    return (
      <Text key={`text-${String(Math.max(lastIndex, 1))}`} style={styles}>
        {segments}
      </Text>
    );
  }
}

const styles = StyleSheet.create({
  jumbo: {
    fontSize: 48,
    lineHeight: 56,
  },
  wrap: {
    flexShrink: 1,
  },
});
