import { Muted, Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import { MarkdownRenderer } from './MarkdownRenderer';
import { createTokenStyles } from '@oxy.so/bloom/theme';

interface DeckSlide {
  title: string;
  subtitle?: string;
  bullets?: string[];
  body?: string;
  notes?: string;
}

interface DeckRendererProps {
  data: { slides?: DeckSlide[] };
}

/**
 * A slide deck, one card per slide in reading order. Presenting it is the host's
 * (Astro opens a deck in a tab of its own); here it is read like a document.
 */
export function DeckRenderer({ data }: DeckRendererProps) {
  const styles = useStyles();
  const slides = Array.isArray(data.slides) ? data.slides : [];
  return (
    <View style={styles.deck}>
      {slides.map((slide, i) => (
        <View key={i} style={styles.slide}>
          <View style={styles.slideHeader}>
            <Text variant="body-semibold">{slide.title}</Text>
            <Muted>{i + 1}</Muted>
          </View>
          {slide.subtitle ? <Muted>{slide.subtitle}</Muted> : null}
          {slide.bullets?.length ? (
            <MarkdownRenderer data={{ content: slide.bullets.map((b) => `- ${b}`).join('\n') }} />
          ) : null}
          {slide.body ? <MarkdownRenderer data={{ content: slide.body }} /> : null}
        </View>
      ))}
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  deck: { gap: 12 },
  slide: {
    gap: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.popover,
    padding: 16,
  },
  slideHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
}));
