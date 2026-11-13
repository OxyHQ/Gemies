import { memo } from 'react';
import { Text } from 'react-native';
import { useConversationActivityText } from '../realtime/activity-text';

export { activityText, useConversationActivityText } from '../realtime/activity-text';

export interface GemieActivityLineProps {
  conversationId: string | null | undefined;
  /** Classes for the line (NativeWind); a small muted line by default. */
  className?: string;
}

/**
 * WhatsApp's line under a chat's name: "Pepe is typing…", "Alia is thinking…", live from the
 * account's realtime connection. Draws nothing while nobody is doing anything.
 */
export const GemieActivityLine = memo(function GemieActivityLine({
  conversationId,
  className = 'text-xs text-primary',
}: GemieActivityLineProps) {
  const text = useConversationActivityText(conversationId);
  if (!text) return null;
  return (
    <Text className={className} numberOfLines={1} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
});
