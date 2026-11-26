import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import { AvatarAnchor } from '@oxy.so/bloom/avatar-flight';
import { Text, fontFamilyStyle } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import { ANCHORS, useGemieFlights } from '../lib/flights';
import { greetingLines } from '../lib/greeting';
import { ALIA_LEAD, type GemieLead } from '../lib/participants';
import { GemieAvatar } from './GemieAvatar';
import { createTokenStyles } from '@oxy.so/bloom/theme';

export interface GemieWelcomeMessageProps {
  /** The greeting, e.g. "Hi Nate, what's on your mind?". */
  greeting: string;
  subtitle?: string;
  markSize?: number;
  /** Who greets: the agent the chat was opened on. Default Alia. */
  lead?: GemieLead;
}

/**
 * The empty chat's greeting: the lead's avatar above it, both centred, the address on top ("Hi Nate,")
 * and the rest under it (`greetingLines`). The Alia app and the SDK chat
 * draw exactly this. The greeting has a max width (`max-w-md`, 28rem) so it sets in two lines at
 * any width, as a headline under a mark rather than one long line across a wide column. The
 * suggestions are not part of it; they sit over the composer (`ComposerSuggestions`).
 */
export function GemieWelcomeMessage({
  greeting,
  subtitle,
  markSize = 88,
  lead = ALIA_LEAD,
}: GemieWelcomeMessageProps) {
  const styles = useStyles();
  const flights = useGemieFlights();
  const avatar = lead.isAlia ? (
    <GemieAvatar size={markSize} interactive />
  ) : (
    <AgentAvatar character={lead.character} size={markSize} label={lead.name} interactive />
  );
  return (
    <View style={styles.welcome}>
      <View style={styles.lead}>
        {/* It flies up into the header's profile when the conversation begins. */}
        {flights ? (
          <AvatarAnchor flights={flights} anchor={ANCHORS.welcome}>
            {avatar}
          </AvatarAnchor>
        ) : (
          avatar
        )}
        <Text selectable={false} style={styles.greeting}>
          {greetingLines(greeting).join('\n')}
        </Text>
      </View>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  welcome: { alignItems: 'center', gap: 8 },
  lead: { alignItems: 'center', justifyContent: 'center', gap: 16 },
  // A title this size is set in the display face, as Bloom's Text set a `text-4xl` class.
  greeting: {
    ...fontFamilyStyle('display'),
    maxWidth: 448,
    flexShrink: 1,
    textAlign: 'center',
    fontSize: 36,
    lineHeight: 40,
    color: t.foreground,
  },
  subtitle: { textAlign: 'center', fontSize: 18, color: t.mutedForeground, lineHeight: 28 },
}));
