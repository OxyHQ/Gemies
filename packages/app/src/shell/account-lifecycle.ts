import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useInsertionEffect, useLayoutEffect, useRef } from 'react';
import { useConversationStore, useThoughtStore } from '@gemies/sdk/runtime';
import { useStore } from '@/features/chat/runtime/global-store';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { useLibraryStore } from '@/features/library/runtime/library-store';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';
import {
  advanceAccountEpoch,
  bindAccountProjectionShell,
  commitAccountProjection,
  releaseAccountProjectionShell,
} from '@/shared/state/account-epoch';

/**
 * What happens to the previous account's in-memory state when the signed-in
 * account changes: a sign-out, or a switch to another account (#608 §4).
 *
 * The account's data that must survive a restart (the sidebar's agents and spaces, and the SDK's
 * conversations, collections and threads) lives in the account's bloom-data store, which Services
 * swaps before the new account is published: nothing here touches it. Every React Query query and
 * mutation is the app's own and memory only, so all of them are dropped: the queries are cancelled
 * and reset (an observed one reads again, for the new account), and a write still waiting for the
 * network is forgotten rather than replayed as the next account. The in-memory stores are reset,
 * and the epoch advances so outstanding store reads cannot publish the old account.
 *
 * Signing IN from signed-out is not a change of owner: nothing was cached for
 * nobody, and the draft somebody typed before signing in is theirs. The caller
 * skips it (`useAccountLifecycle`).
 */
export function resetAccountSession(queryClient: QueryClient): void {
  advanceAccountEpoch();

  const ui = useUIStore.getState();
  useUIStore.setState(
    {
      ...useUIStore.getInitialState(),
      rightPanelWidth: ui.rightPanelWidth,
    },
    true,
  );
  useStore.setState(useStore.getInitialState(), true);
  // The thought panel carries a conversation's messages.
  useThoughtStore.setState(useThoughtStore.getInitialState(), true);
  // The first message queued for a conversation that was just created, and which row streams.
  useConversationStore.setState(useConversationStore.getInitialState(), true);
  useUserDataStore.setState(useUserDataStore.getInitialState(), true);
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);

  queryClient.getMutationCache().clear();
  void queryClient.cancelQueries().then(() => queryClient.resetQueries());
}

/**
 * Runs {@link resetAccountSession} when the signed-in account moves on from
 * one that was signed in — never on the first sign-in from signed-out.
 * Mounted once, by the app layout, next to the account-scoped store bindings.
 */
export function useAccountLifecycle(userId: string | null, sessionId: string | null = null): void {
  const shell = useRef({});
  useInsertionEffect(() => {
    const lease = shell.current;
    bindAccountProjectionShell(lease);
    return () => releaseAccountProjectionShell(lease);
  }, []);
  useLayoutEffect(() => {
    commitAccountProjection(userId, sessionId);
  }, [userId, sessionId]);
  const queryClient = useQueryClient();
  const previous = useRef(userId);
  useEffect(() => {
    const was = previous.current;
    previous.current = userId;
    if (was === null || was === userId) return;
    resetAccountSession(queryClient);
  }, [userId, queryClient]);
}
