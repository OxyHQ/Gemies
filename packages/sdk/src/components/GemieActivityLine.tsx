import { createTokenStyles } from '@oxy.so/bloom/theme';
import { memo } from 'react';
import { type StyleProp, Text, type TextStyle } from 'react-native';
import { useConversationActivityText } from '../realtime/activity-text';

export { activityText, useConversationActivityText } from '../realtime/activity-text';

export interface GemieActivityLineProps {
  conversationId: string | null | undefined;
  /** Laid over the line's own look: small text in the theme's primary. */
  style?: StyleProp<TextStyle>;
}

/**
 * WhatsApp's line under a chat's name: "Pepe is typing…", "Alia is thinking…", live from the
 * account's realtime connection. Draws nothing while nobody is doing anything.
 */
export const GemieActivityLine = memo(function GemieActivityLine({
  conversationId,
  style,
}: GemieActivityLineProps) {
  const styles = useStyles();
  const text = useConversationActivityText(conversationId);
  if (!text) return null;
  return (
    <Text style={[styles.line, style]} numberOfLines={1} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
});

const useStyles = createTokenStyles((t) => ({
  line: { fontSize: 12, lineHeight: 16, color: t.primary },
}));
