import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View, StyleSheet } from 'react-native';

/** Widths that vary row to row: identical ones read as a pattern, not as text. */
const ROW_WIDTHS = ['58%', '72%', '48%'] as const;

/**
 * A sidebar folder that is on its way: its label and, indented under it, the contact rows (an
 * avatar, a name and a line) it will hold, shaped like the sidebar's own so nothing moves when the
 * folders arrive. For the Spaces section: it waits with THIS, never a spinner or a "Loading" line.
 */
export function FolderRowsSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <Skeleton.Region>
      <View style={styles.folder}>
        <Skeleton.Box width="30%" height={11} />
        {Array.from({ length: rows }, (_, index) => (
          <View key={index} style={styles.contact}>
            <Skeleton.Circle size={36} />
            <View style={styles.contactLines}>
              <Skeleton.Box width={ROW_WIDTHS[index % ROW_WIDTHS.length]} height={13} />
              <Skeleton.Box width="80%" height={11} />
            </View>
          </View>
        ))}
      </View>
    </Skeleton.Region>
  );
}

const styles = StyleSheet.create({
  folder: { gap: 12, paddingHorizontal: 8, paddingVertical: 4 },
  contact: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 12 },
  contactLines: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', gap: 6 },
});
