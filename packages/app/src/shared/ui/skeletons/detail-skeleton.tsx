import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View, StyleSheet } from 'react-native';

/**
 * A detail page that is on its way: a header (a mark, a title and a line) and the paragraphs
 * under it. For an agent, a skill, an invitation: the page's own frame is drawn at once and this
 * holds the place of what the lookup brings.
 */
export function DetailSkeleton({ paragraphs = 3 }: { paragraphs?: number }) {
  return (
    <Skeleton.Region style={styles.detail}>
      <View style={styles.header}>
        <Skeleton.Circle size={64} />
        <View style={styles.headerLines}>
          <Skeleton.Box width="50%" height={20} />
          <Skeleton.Box width="30%" height={14} />
        </View>
      </View>
      <View style={styles.paragraphs}>
        {Array.from({ length: paragraphs }, (_, index) => (
          <View key={index} style={styles.paragraph}>
            <Skeleton.Box width="100%" height={13} />
            <Skeleton.Box width="94%" height={13} />
            <Skeleton.Box width={index % 2 === 0 ? '62%' : '48%'} height={13} />
          </View>
        ))}
      </View>
    </Skeleton.Region>
  );
}

const styles = StyleSheet.create({
  detail: { gap: 24, padding: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  headerLines: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', gap: 8 },
  paragraphs: { gap: 16 },
  paragraph: { gap: 8 },
});
