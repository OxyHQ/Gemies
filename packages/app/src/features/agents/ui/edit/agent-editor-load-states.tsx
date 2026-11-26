import { errorStatus, errorMessage as getErrorMessage } from '@/shared/api/error-utils';
import { useTranslation } from '@/shared/i18n/use-translation';
import { EmptyState } from '@/shared/ui/empty-state';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View, StyleSheet } from 'react-native';

/**
 * The editor's agent could not be loaded.
 *
 * The two answers the route gives are told apart here: a 404 is the route's
 * deliberate "not yours, or not there", which no retry changes, so the way out
 * is the list; anything else is transient and gets a Retry that runs the same
 * query.
 */
export function AgentEditorLoadFailed({
  error,
  notYours = false,
  onRetry,
  onBackToList,
}: {
  error?: unknown;
  /** The agent loaded, and the caller may neither edit it nor manage anything on it. */
  notYours?: boolean;
  onRetry: () => void;
  onBackToList: () => void;
}) {
  const { t } = useTranslation();
  const notFound = notYours || errorStatus(error) === 404;

  return (
    <View style={styles.failed}>
      <EmptyState
        title={notFound ? t('agents.notFound') : t('agents.loadFailed')}
        description={
          notFound ? t('agents.notFoundDetail') : getErrorMessage(error, t('agents.loadFailed'))
        }
        action={
          notFound
            ? { label: t('agents.backToAgents'), onPress: onBackToList }
            : { label: t('agents.retry'), onPress: onRetry }
        }
      />
    </View>
  );
}

/**
 * Waiting for the agent. Either the session is still minting its token — the
 * query is disabled until it has — or the fetch is in flight. Both are a wait,
 * and the same one to the person looking at it.
 */
export function AgentEditorLoading() {
  // The editor's own shape: the avatar's stage, its colours, then the fields.
  return (
    <Skeleton.Region style={styles.loading}>
      <Skeleton.Circle size={160} />
      <Skeleton.Box width={260} height={32} borderRadius={16} />
      <View style={styles.fields}>
        {[0, 1, 2].map((row) => (
          <View key={row} style={styles.field}>
            <Skeleton.Box width={80} height={14} />
            <Skeleton.Box width={220} height={32} borderRadius={10} />
          </View>
        ))}
      </View>
    </Skeleton.Region>
  );
}

const styles = StyleSheet.create({
  failed: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', justifyContent: 'center', padding: 24 },
  loading: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    gap: 24,
    padding: 16,
  },
  fields: { width: '100%', gap: 12 },
  field: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
});
