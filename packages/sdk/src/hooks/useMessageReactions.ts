import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services/ui/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useLabels } from '../lib/labels';
import { useGemieApi } from '../runtime/api';
import { GEMIES_API_ROUTES } from '../runtime/model';
import {
  MessageReactionController,
  readMessageReactionUpdate,
  readMessageReactionAcknowledgement,
  type MessageReactionSnapshot,
} from '../runtime/message-reactions';
import { updateReactionCaches } from '../runtime/reaction-cache';
import { useGemieRealtime } from '../realtime/react';

const NONE: readonly string[] = [];

/** Save a reaction's desired state; only pending intent overrides the latest server revision. */
export function useMessageReactions({
  conversationIds = [],
  onChange,
  enabled = true,
}: {
  conversationIds?: readonly string[];
  onChange?: (update: MessageReactionSnapshot) => void;
  enabled?: boolean;
} = {}) {
  const { t } = useLabels();
  const api = useGemieApi();
  const { user } = useOxy();
  const queryClient = useQueryClient();
  const [version, changed] = useReducer((value: number) => value + 1, 0);
  const callbacks = useRef({ onChange, t });
  callbacks.current = { onChange, t };
  const accountId = user?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: account identity scopes pending reactions
  const controller = useMemo(
    () =>
      new MessageReactionController({
        send: async ({ conversationId, messageId, emoji, active, mutationId }) => {
          const { data } = await api.post<Record<string, unknown>>(
            GEMIES_API_ROUTES.conversations.react(conversationId, messageId),
            { emoji, active, mutationId },
          );
          const update = readMessageReactionAcknowledgement(
            data,
            conversationId,
            messageId,
            mutationId,
          );
          if (!update) throw new Error('Invalid reaction acknowledgement');
          return update;
        },
        changed,
        confirmed: (update) => {
          updateReactionCaches(queryClient, update);
          callbacks.current.onChange?.(update);
        },
        failed: () => toast.error(callbacks.current.t('chat.reactionFailed')),
      }),
    [api, queryClient, accountId],
  );

  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);

  // Reactions changed anywhere — another device, a gemie — arrive as `message.reaction`.
  const subscriptions = JSON.stringify([...new Set(conversationIds)].sort());
  const realtime = useGemieRealtime();
  useEffect(() => {
    if (!enabled || !realtime) return;
    const ids = new Set<string>(JSON.parse(subscriptions));
    return realtime.on('message.reaction', (frame) => {
      const update = readMessageReactionUpdate(frame.data);
      if (update && ids.has(update.conversationId)) controller.receive(update);
    });
  }, [controller, enabled, realtime, subscriptions]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each update refreshes memoized rows
  const reactionsOf = useCallback(
    (
      messageId: string,
      stored: readonly string[] = NONE,
      conversationId?: string,
      revision = 0,
    ): readonly string[] =>
      conversationId === undefined
        ? stored
        : controller.reactionsOf(conversationId, messageId, stored, revision),
    [controller, version],
  );

  const toggle = useCallback(
    (
      messageId: string,
      emoji: string,
      stored: readonly string[] | undefined,
      conversationId: string | undefined,
      revision = 0,
    ) => {
      if (!enabled) return;
      if (conversationId === undefined) {
        toast.error(callbacks.current.t('chat.reactionFailed'));
        return;
      }
      controller.toggle(conversationId, messageId, emoji, stored ?? NONE, revision);
    },
    [controller, enabled],
  );
  return { reactionsOf, toggle };
}
