import { Chip } from '@oxy.so/bloom/chip';
import { Text } from '@oxy.so/bloom/typography';
import type { ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';

/** A section of the agent overview: its heading, then its content. */
export function AgentDetailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Text variant="headline-semibold">{title}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

/** Static chips in a wrapping row — capabilities, tags. */
export function ChipList({ items }: { items: string[] }) {
  return (
    <View style={styles.chips}>
      {items.map((item, i) => (
        <Chip key={i} size="lg">
          {item}
        </Chip>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
