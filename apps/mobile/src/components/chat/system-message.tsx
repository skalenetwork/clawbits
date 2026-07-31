import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { useTheme } from '@/hooks/use-theme';
import type { MmChannelEvent } from '@/lib/api';

interface SystemMessageProps {
  event: MmChannelEvent;
  /** When the actor matches the viewer's human id, the renderer says
   *  "You" — matches the web client and the Slack convention. */
  viewerHumanId?: number | null;
}

/** Centered, non-interactive inline channel event. Mobile counterpart
 *  of ``frontend/src/components/chat/SystemMessage.tsx`` — the four
 *  user-visible strings derive from the two stored ``event_type``s
 *  plus the actor-vs-subject identity check (server normalises
 *  self-actions to NULL subject at emit time). */
export const SystemMessage = memo(function SystemMessage({
  event,
  viewerHumanId,
}: SystemMessageProps) {
  const theme = useTheme();
  const isAdded = event.event_type === 'member.added';
  const isRemoved = event.event_type === 'member.removed';
  const hasSubject =
    event.subject_human_id != null || event.subject_agent_id != null;

  const actorIsViewer =
    viewerHumanId != null && event.actor_human_id === viewerHumanId;
  const subjectIsViewer =
    viewerHumanId != null && event.subject_human_id === viewerHumanId;

  const actorLabel = actorIsViewer
    ? 'You'
    : event.actor_display_name ??
      (event.actor_agent_id ? `@${event.actor_agent_id}` : 'Someone');
  const subjectLabel = subjectIsViewer
    ? 'you'
    : event.subject_display_name ??
      (event.subject_agent_id ? `@${event.subject_agent_id}` : 'someone');

  let verbPhrase: string;
  if (isAdded && hasSubject) {
    verbPhrase = `added ${subjectLabel} to the channel`;
  } else if (isAdded) {
    verbPhrase = 'joined the channel';
  } else if (isRemoved && hasSubject) {
    verbPhrase = `removed ${subjectLabel} from the channel`;
  } else if (isRemoved) {
    verbPhrase = 'left the channel';
  } else {
    // Unknown event type — render a minimal "did something" fallback.
    verbPhrase = event.event_type;
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.inner}>
        <Avatar
          uri={event.actor_avatar?.url}
          name={event.actor_display_name ?? event.actor_agent_id ?? '?'}
          size={16}
          framed={false}
        />
        <Text style={[styles.text, { color: theme.textSecondary }]}>
          <Text style={[styles.actor, { color: theme.text }]}>{actorLabel}</Text>{' '}
          {verbPhrase}
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  actor: {
    fontWeight: '600',
  },
  inner: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 16,
  },
  text: {
    flexShrink: 1,
    fontSize: 12,
    letterSpacing: -0.05,
  },
  wrap: {
    alignItems: 'center',
    paddingVertical: 6,
  },
});
