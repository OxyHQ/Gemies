import { Notification } from '@oxy.so/bloom/notification';
import { Muted } from '@oxy.so/bloom/typography';
import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLabels } from '../../lib/labels';
import {
  ApprovalExpiredError,
  type ApprovalDecision,
  type ApprovalEntry,
  type ApprovalOutcome,
} from '../../runtime/approvals';

export interface ApprovalsProps {
  readonly entries: readonly ApprovalEntry[];
  /** Who is asking: the agent's name, as the thread names it. */
  readonly agentName: string;
  /**
   * Carries the person's answer to Gemies. Rejects with `ApprovalExpiredError` when the question is
   * no longer open. Omitted, a question is shown with no way to answer it.
   */
  readonly onDecide?: (entry: ApprovalEntry, decision: ApprovalDecision) => Promise<void>;
  /** The answer is known here (the person's own, or the question closed): show it now. */
  readonly onSettled: (requestId: string, outcome: ApprovalOutcome) => void;
}

/**
 * A coding CLI asking its own user for permission to run something on their computer, in the
 * conversation (Gemies ADR 0043 §5): who is asking, what for, and the two answers. The CLI waits
 * for the person; once answered the card shrinks to one line saying how it ended.
 *
 * This is the CLI's prompt to the person who runs it, not a permission Gemies or Oxy asks for.
 */
export const ApprovalCards = React.memo(function ApprovalCards({
  entries,
  agentName,
  onDecide,
  onSettled,
}: ApprovalsProps) {
  return (
    <>
      {entries.map((entry) => (
        <ApprovalCard
          key={entry.requestId}
          entry={entry}
          agentName={agentName}
          onDecide={onDecide}
          onSettled={onSettled}
        />
      ))}
    </>
  );
});

function ApprovalCard({
  entry,
  agentName,
  onDecide,
  onSettled,
}: {
  entry: ApprovalEntry;
  agentName: string;
  onDecide: ApprovalsProps['onDecide'];
  onSettled: ApprovalsProps['onSettled'];
}) {
  const { t } = useLabels();
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  const decide = useCallback(
    (decision: ApprovalDecision) => {
      if (sending || !onDecide) return;
      setSending(true);
      setFailed(false);
      onDecide(entry, decision).then(
        () => onSettled(entry.requestId, decision),
        (error: unknown) => {
          setSending(false);
          if (error instanceof ApprovalExpiredError) onSettled(entry.requestId, 'expired');
          else setFailed(true);
        },
      );
    },
    [sending, onDecide, entry, onSettled],
  );

  if (entry.outcome !== 'pending') {
    return (
      <View style={styles.resolved} accessibilityRole="text">
        <Muted>{t(`chat.approval.resolved.${entry.outcome}`, { tool: entry.tool })}</Muted>
      </View>
    );
  }

  const description = [entry.summary, failed ? t('chat.approval.sendFailed') : undefined]
    .filter(Boolean)
    .join('\n');
  return (
    <Notification
      status="warning"
      title={t('chat.approval.title', { agent: agentName, tool: entry.tool })}
      description={description === '' ? undefined : description}
      // While an answer is on its way there is nothing to press: a second tap must not send another.
      actions={
        onDecide && !sending
          ? [
              { label: t('chat.approval.deny'), onPress: () => decide('deny') },
              { label: t('chat.approval.allow'), onPress: () => decide('allow') },
            ]
          : undefined
      }
      dismissible={false}
    />
  );
}

const styles = StyleSheet.create({
  resolved: { paddingHorizontal: 16, paddingVertical: 4 },
});
