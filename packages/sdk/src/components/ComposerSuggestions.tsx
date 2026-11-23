import { ListItem } from '@oxy.so/bloom/list';
import { Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import type { Completion } from '../lib/suggestions';
import type { GemieSuggestion } from '../types';
import { createTokenStyles } from '@oxy.so/bloom/theme';

/**
 * Suggestions over the composer, one line each, the typed part highlighted and the row the
 * keyboard is on marked. The Alia app and the SDK chat draw exactly this.
 */
export function ComposerSuggestions<T extends GemieSuggestion>({
  completions,
  selected,
  onPick,
}: {
  completions: readonly Completion<T>[];
  selected: number;
  onPick: (suggestion: T) => void;
}) {
  const styles = useStyles();
  if (completions.length === 0) return null;
  return (
    <View accessibilityRole="list" style={styles.list}>
      {completions.map(({ suggestion, matchStart, matchEnd }, index) => {
        const { text } = suggestion;
        return (
          <ListItem
            key={suggestion.id}
            active={index === selected}
            role="button"
            label={text}
            onPress={() => onPick(suggestion)}
            title={
              <Text numberOfLines={1}>
                {text.slice(0, matchStart)}
                <Text style={styles.match}>{text.slice(matchStart, matchEnd)}</Text>
                {text.slice(matchEnd)}
              </Text>
            }
          />
        );
      })}
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  list: { width: '100%', maxWidth: 768, alignSelf: 'center' },
  match: { fontWeight: 500, color: t.primary },
}));
