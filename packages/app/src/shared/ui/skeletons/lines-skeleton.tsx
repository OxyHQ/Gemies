import * as Skeleton from '@oxy.so/bloom/skeleton';
import { type StyleProp, StyleSheet, type ViewStyle } from 'react-native';

const WIDTHS = ['72%', '88%', '54%', '80%', '63%', '91%', '46%', '76%'] as const;

/**
 * Lines of text that are on their way, for a panel whose content is a document or a console (the
 * agent's terminal while it connects, a file while it is read): uneven, so they read as text.
 */
export function LinesSkeleton({
  lines = 8,
  style,
}: {
  lines?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Skeleton.Region style={[styles.lines, style]}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton.Box key={index} width={WIDTHS[index % WIDTHS.length]} height={12} />
      ))}
    </Skeleton.Region>
  );
}

const styles = StyleSheet.create({
  lines: { gap: 10, padding: 12 },
});
