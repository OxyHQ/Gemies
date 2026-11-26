import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View, StyleSheet } from 'react-native';

/**
 * A conversation's turns that are on their way: the person's bubbles at the end, the replies as
 * lines at the start, with the shape and the uneven widths of the real thread, so nothing moves
 * when it arrives. The one placeholder of every surface that waits for a thread (the chat, a
 * shared conversation).
 */
export function ThreadSkeleton() {
  return (
    <Skeleton.Region style={styles.skeleton}>
      <View style={styles.question}>
        <Skeleton.Box width="65%" height={48} borderRadius={24} />
      </View>
      <View style={styles.reply}>
        <Skeleton.Box width="80%" height={14} borderRadius={8} />
        <Skeleton.Box width="70%" height={14} borderRadius={8} />
        <Skeleton.Box width="45%" height={14} borderRadius={8} />
      </View>
      <View style={styles.question}>
        <Skeleton.Box width="50%" height={40} borderRadius={24} />
      </View>
      <View style={styles.reply}>
        <Skeleton.Box width="85%" height={14} borderRadius={8} />
        <Skeleton.Box width="60%" height={14} borderRadius={8} />
      </View>
    </Skeleton.Region>
  );
}

const styles = StyleSheet.create({
  skeleton: { gap: 20, paddingVertical: 16 },
  question: { alignItems: 'flex-end' },
  reply: { alignItems: 'flex-start', gap: 10 },
});
