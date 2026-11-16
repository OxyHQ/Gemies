import type { AgentThreadSummary as AgentThread } from '@/features/agents/runtime/use-agent-threads';
import { useTranslation } from '@/shared/i18n/use-translation';
import { List } from '@oxy.so/bloom/list';
import { Text } from '@oxy.so/bloom/typography';

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** The caller's latest threads with the agent; nothing at all when there are none. */
export function AgentThreadsList({
  threads,
  onOpen,
}: {
  threads: readonly AgentThread[];
  onOpen: (thread: AgentThread) => void;
}) {
  const { t } = useTranslation();
  if (threads.length === 0) return null;

  return (
    <List
      sections={[
        {
          id: 'threads',
          title: t('agents.threads'),
          items: threads.slice(0, 8).map((thread) => ({
            id: thread.id,
            title: thread.title,
            supporting: t(thread.status === 'open' ? 'agents.threadOpen' : 'agents.threadClosed'),
            trailing: (
              <Text variant="caption-1-regular">{formatRelativeTime(thread.updatedAt)}</Text>
            ),
            onPress: () => onOpen(thread),
          })),
        },
      ]}
    />
  );
}
