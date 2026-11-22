/**
 * The conversation hooks: the person's conversations as their account's store holds them
 * (`data/conversations.ts`), read and written in the store of the tree (`OxyProvider`'s, the
 * signed-in account's).
 *
 * Reads wait for the private API (`canUsePrivateApi`): until then they observe nothing. Writes are
 * the store's actions, each bound to the provider's client.
 */
import {
  type ActionView,
  type ListView,
  type RecordView,
  skip,
  useEntities,
  useList,
  useRecord,
  useStore,
  withStore,
} from '@oxy.so/bloom-data';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services/ui/client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLabels } from '../lib/labels';
import { useGemieRealtime, useRealtimeEvent, useRealtimeReset } from '../realtime/react';
import type { RealtimeData } from '../realtime/contract';
import { useGemieApi } from './api';
import { useGemieRuntime } from './config';
import {
  type ConversationsClient,
  type ConversationsFilter,
  type CreateConversationInput,
  type SaveConversationInput,
  Conversations,
  clearConversation,
  conversation,
  conversationList,
  conversationsKey,
  createConversation,
  deleteConversation,
  markConversationRead,
  OfflineConversations,
  refreshConversationLists,
  renameConversation,
  saveConversation,
} from './data/conversations';
import { errorMessage } from './error-utils';
import type { Conversation } from './types';
import { useBoundAction } from './use-bound-action';

/** The provider's conversation client: what every conversation read and write is given. */
export function useConversationsClient(): ConversationsClient {
  const api = useGemieApi();
  const { offline, app } = useGemieRuntime();
  const { newChat } = useLabels();
  const realtime = useGemieRealtime();
  return useMemo(
    () => ({
      api,
      offline: new OfflineConversations(offline),
      newChatTitle: newChat,
      app,
      realtime,
    }),
    [api, offline, newChat, app, realtime],
  );
}

/** A list of conversations as a screen reads it: the list's view and its rows, in order. */
export interface ConversationsView extends ListView<unknown> {
  readonly conversations: readonly Conversation[];
}

/**
 * The person's conversations, newest first, a page at a time (`more()`). The sidebar and the
 * sheet read this. Given `agentId`, only the conversations with that agent; given `app`, only the
 * ones started in that app (`GET /v1/conversations?agentId=&app=`); given `kind: 'gemies'`, the
 * conversations the person's gemies have with each other (ADR 0042), each with both gemies in
 * `members`. A realtime reset reads it again.
 *
 * While the session is unavailable (a 401) the person's own list shows the offline copy, when the
 * runtime has one; it is a display fallback, never a server answer.
 */
export function useConversations(filter: ConversationsFilter = {}): ConversationsView {
  const { user, isAuthenticated, canUsePrivateApi } = useOxy();
  const client = useConversationsClient();
  const { offline: offlineStore } = useGemieRuntime();
  const { agentId, app, kind } = filter;
  const key = conversationsKey(filter);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key identifies the filter
  const stableFilter = useMemo(() => ({ agentId, app, kind }), [key]);
  const view = useList(conversationList, ...(canUsePrivateApi ? [client, stableFilter] : [skip]));
  useRealtimeReset(() => void view.refresh());
  const rows = useEntities(Conversations, view.ids);

  const accountId = user?.id;
  const [offline, setOffline] = useState<{
    accountId: string | undefined;
    rows: readonly Conversation[];
  } | null>(null);
  useEffect(() => {
    if (!isAuthenticated || key !== 'all') return;
    let current = true;
    void new OfflineConversations(offlineStore ?? null)
      .read()
      .then((stored) => {
        if (current && stored.length) {
          setOffline({ accountId, rows: stored.map(({ messages: _m, ...row }) => row) });
        }
      })
      .catch(() => {
        /* A damaged offline copy must not mask the server's answer. */
      });
    return () => {
      current = false;
    };
  }, [accountId, offlineStore, isAuthenticated, key]);

  const conversations = useMemo(() => {
    const held = rows.filter((row): row is Conversation => row !== undefined);
    if (view.list || !isAuthenticated || offline?.accountId !== accountId) return held;
    return offline?.rows ?? held;
  }, [rows, view.list, isAuthenticated, offline, accountId]);
  return { ...view, conversations };
}

/**
 * One conversation with its messages. A row the sidebar holds shows at once (without messages)
 * while the conversation is read. A rewritten thread (a realtime `reload`, an edit or a
 * regenerate on another device) and a realtime reset read it again; `onReload` hears the
 * rewritten conversation once it is read.
 */
export function useConversation(
  id: string | undefined,
  { onReload }: { onReload?: (fresh: Conversation) => void } = {},
): RecordView<Conversation> {
  const { canUsePrivateApi } = useOxy();
  const client = useConversationsClient();
  const store = useStore();
  const view = useRecord(conversation, ...(canUsePrivateApi && id ? [client, id] : [skip]));
  useRealtimeEvent('conversation', (frame) => {
    const data = frame.data as RealtimeData['conversation'];
    if (!data.reload || id === undefined || data.conversation.id !== id) return;
    void view.refresh().then(() => {
      const read = withStore(store, () => ({
        status: conversation.state(client, id).status,
        fresh: Conversations.get(id),
      }));
      if (read.status === 'success' && read.fresh) onReload?.(read.fresh);
    });
  });
  useRealtimeReset(() => void view.refresh());
  return view;
}

/**
 * Mark a conversation seen: its unread count goes to zero here at once and on every other surface
 * through the server's `conversation` event. Send it only when there is something unread.
 */
export function useMarkConversationRead(): (id: string) => void {
  const store = useStore();
  const client = useConversationsClient();
  return useCallback(
    (id) => {
      void withStore(store, () => markConversationRead(client, id)).catch(() => undefined);
    },
    [store, client],
  );
}

/** Read a conversation ahead of its press (the sidebar's press-in or hover). Never retried. */
export function usePrefetchConversation(): (id: string) => void {
  const store = useStore();
  const client = useConversationsClient();
  return useCallback(
    (id) => {
      void withStore(store, () => conversation.fetch(client, id));
    },
    [store, client],
  );
}

/**
 * Read a conversation and the lists again: what changed it happened outside this client's reads
 * (a voice call wrote its transcript on the server).
 */
export function useRefreshConversation(): (id: string) => void {
  const store = useStore();
  const client = useConversationsClient();
  return useCallback(
    (id) =>
      withStore(store, () => {
        void conversation.refresh(client, id);
        refreshConversationLists(client);
      }),
    [store, client],
  );
}

/** Tells the person a write failed, with the server's words when it sent some. */
function useFailureToast(fallback: string): (error: unknown) => void {
  return useCallback((error) => toast.error(errorMessage(error, fallback)), [fallback]);
}

/** Save a conversation's messages (and title). */
export function useSaveConversation(): ActionView<[input: SaveConversationInput], Conversation> {
  const labels = useLabels();
  return useBoundAction(
    saveConversation,
    useConversationsClient(),
    useFailureToast(labels.conversationSaveFailed),
  );
}

/** Rename a conversation (`run(id, title)`); the whole thread is read fresh and saved back. */
export function useRenameConversation(): ActionView<[id: string, title: string], Conversation> {
  return useBoundAction(renameConversation, useConversationsClient());
}

/** Delete a conversation (`run(id)`). */
export function useDeleteConversation(): ActionView<[id: string], string> {
  const labels = useLabels();
  return useBoundAction(
    deleteConversation,
    useConversationsClient(),
    useFailureToast(labels.conversationDeleteFailed),
  );
}

/**
 * Empty a conversation on the server, keeping the conversation (`run(id)`).
 *
 * The persistent half of "Clear conversation" (#553). The local half, `setMessages([])` in
 * `useConversationThread`, is NOT enough on its own: the conversation's record still holds the
 * history, and the thread's sync treats "record has messages, screen has none" as a data upgrade
 * and hydrates them straight back. So the record is emptied here, and the caller resets its
 * screen after `run` resolves, when there is no history left to restore. A refusal puts the
 * messages back exactly as they were.
 */
export function useClearConversation(): ActionView<[id: string], string> {
  return useBoundAction(clearConversation, useConversationsClient());
}

/**
 * Create a conversation (optionally the next stretch of an agent's thread).
 *
 * The next stretch of a thread whose open answered a `threadId` (Alia's: `useGemieThread`) is
 * `run({ threadId })`; `{ agentId }` alone would start one more loose chat with her. Of any other
 * gemie's thread it is `{ agentId }`.
 */
export function useCreateConversation(): ActionView<
  [input?: CreateConversationInput],
  Conversation
> {
  const labels = useLabels();
  return useBoundAction(
    createConversation,
    useConversationsClient(),
    useFailureToast(labels.conversationCreateFailed),
  );
}
