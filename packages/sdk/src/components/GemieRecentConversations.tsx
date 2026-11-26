import { ListItem } from '@oxy.so/bloom/list';
import { Text } from '@oxy.so/bloom/typography';
import { useMemo } from 'react';
import { View } from 'react-native';
import { useLabels } from '../lib/labels';
import { useGemieRuntime } from '../runtime/config';
import { useConversations } from '../runtime/conversations';
import { createTokenStyles } from '@oxy.so/bloom/theme';

/** How many of the lead's conversations the sheet offers to pick up again. */
const RECENT_CONVERSATIONS_SHOWN = 3;

/**
 * The person's latest conversations with the sheet's lead, under its greeting: "Ask Sindi" picks
 * up where it left off instead of every opening being a blank page. Alia's own sheet lists the
 * person's latest conversations of any kind. In an app's sheet (the chat's `app`) they are the ones
 * started in that app: Mercaria's sheet offers Mercaria's, never a Homiio chat. Nothing while
 * loading or when there are none.
 */
export function GemieRecentConversations({
  agentId,
  onOpen,
}: {
  /** The lead; omitted, Alia. */
  agentId?: string;
  onOpen: (conversationId: string) => void;
}) {
  const styles = useStyles();
  const labels = useLabels();
  const { app } = useGemieRuntime();
  const { conversations } = useConversations({
    ...(agentId === undefined ? {} : { agentId }),
    ...(app === undefined ? {} : { app }),
  });
  const recent = useMemo(() => conversations.slice(0, RECENT_CONVERSATIONS_SHOWN), [conversations]);
  const when = useMemo(
    () => new Intl.DateTimeFormat(labels.locale, { day: 'numeric', month: 'short' }),
    [labels.locale],
  );
  if (recent.length === 0) return null;
  return (
    <View accessibilityRole="list" style={styles.list}>
      <Text style={styles.heading}>{labels.recentConversations}</Text>
      {recent.map((conversation) => {
        const title = conversation.title || labels.newChat;
        return (
          <ListItem
            key={conversation.id}
            role="button"
            label={title}
            onPress={() => onOpen(conversation.id)}
            title={<Text numberOfLines={1}>{title}</Text>}
            trailing={
              <Text style={styles.updatedAt}>{when.format(new Date(conversation.updatedAt))}</Text>
            }
          />
        );
      })}
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  list: { width: '100%', maxWidth: 480, gap: 4, alignSelf: 'center' },
  heading: { paddingHorizontal: 12, fontSize: 14, color: t.mutedForeground, lineHeight: 20 },
  updatedAt: { fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
}));
