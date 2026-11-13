/**
 * The realtime connection in React (`docs/realtime.mdx`).
 *
 * {@link GemieRealtimeProvider} is mounted by `GemieRuntimeProvider`: it holds the signed-in
 * account's connection to the runtime's API and keeps the runtime's caches and the activity store
 * in step with it. Everything else only listens: {@link useRealtimeEvent} for a type,
 * {@link useRealtimeTopic} for an agent run, {@link useConversationActivity} for "typing…".
 */

import { QueryClientContext } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRealtimeActivityStore } from './activity';
import { attachRealtimeCache } from './cache';
import { acquireRealtime, type RealtimeConnection, type RealtimeListener } from './connection';
import type { RealtimeActivity, RealtimeFrame, RealtimeType } from './contract';

interface RealtimeHold {
  readonly apiUrl: string;
  readonly connection: RealtimeConnection | null;
}

const RealtimeContext = createContext<RealtimeHold | null>(null);

/** Hold the signed-in account's connection to `apiUrl`; `null` while signed out. */
function useHeldConnection(apiUrl: string, enabled: boolean): RealtimeConnection | null {
  const { oxyServices, user, canUsePrivateApi } = useOxy();
  const account = enabled && canUsePrivateApi ? (user?.id ?? null) : null;
  const [connection, setConnection] = useState<RealtimeConnection | null>(null);

  useEffect(() => {
    if (!account) {
      setConnection(null);
      return;
    }
    // The API's own token, refreshed by Oxy when it is due — never a captured one.
    const linked = oxyServices.createLinkedClient({ baseURL: apiUrl });
    const held = acquireRealtime(apiUrl, account, () => linked.getAccessToken(apiUrl));
    setConnection(held.connection);
    return () => {
      held.release();
      linked.dispose();
      setConnection(null);
    };
  }, [apiUrl, account, oxyServices]);

  return connection;
}

const activityHolders = new WeakMap<RealtimeConnection, { refs: number; detach: () => void }>();

/** Feed a connection's `activity` frames into the store, once per connection. */
function attachActivity(connection: RealtimeConnection): () => void {
  const existing = activityHolders.get(connection);
  if (existing) existing.refs++;
  else {
    const store = useRealtimeActivityStore.getState;
    const offFrames = connection.on('activity', (frame) =>
      store().apply(frame.data as RealtimeActivity),
    );
    // What happened while away is unknown: a stale "typing…" is worse than none.
    const offStatus = connection.onStatus((connected) => {
      if (!connected) store().clear();
    });
    activityHolders.set(connection, {
      refs: 1,
      detach: () => {
        offFrames();
        offStatus();
        store().clear();
      },
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = activityHolders.get(connection);
    if (!entry || --entry.refs > 0) return;
    entry.detach();
    activityHolders.delete(connection);
  };
}

/**
 * Mounted by `GemieRuntimeProvider`: the account's connection for everything below, wired into the
 * runtime's caches and the activity store. A nested provider on the same API shares its parent's.
 */
export function GemieRealtimeProvider({
  apiUrl,
  children,
}: {
  apiUrl: string;
  children: ReactNode;
}) {
  const parent = useContext(RealtimeContext);
  const inherited = parent !== null && parent.apiUrl === apiUrl;
  const connection = useHeldConnection(apiUrl, !inherited);
  // A host without React Query has no runtime caches to keep; it still hears activity.
  const queryClient = useContext(QueryClientContext);
  useEffect(() => {
    if (inherited || !connection) return;
    const detachCache = queryClient ? attachRealtimeCache(connection, queryClient) : undefined;
    const detachActivity = attachActivity(connection);
    return () => {
      detachCache?.();
      detachActivity();
    };
  }, [inherited, connection, queryClient]);
  const value = useMemo<RealtimeHold>(
    () => (inherited && parent ? parent : { apiUrl, connection }),
    [inherited, parent, apiUrl, connection],
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

/** The account's realtime connection, or `null` while signed out or outside a runtime provider. */
export function useGemieRealtime(): RealtimeConnection | null {
  return useContext(RealtimeContext)?.connection ?? null;
}

/** Call `handler` for every frame of `type` while mounted (the latest `handler`, without resubscribing). */
export function useRealtimeEvent<T extends RealtimeType | '*'>(
  type: T,
  handler: (frame: RealtimeFrame) => void,
): void {
  const connection = useGemieRealtime();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!connection) return;
    const listener: RealtimeListener = (frame) => ref.current(frame);
    return connection.on(type, listener);
  }, [connection, type]);
}

/** Call `handler` when the client must reload what it shows (its cursor fell out of the log). */
export function useRealtimeReset(handler: () => void): void {
  const connection = useGemieRealtime();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!connection) return;
    return connection.onReset(() => ref.current());
  }, [connection]);
}

/**
 * Follow a topic (`agent:<id>`, `agent-session:<id>`) while mounted, and hear its frames. The
 * server checks the person may; a refused topic simply never speaks.
 */
export function useRealtimeTopic(
  topic: string | null,
  handler: (frame: RealtimeFrame) => void,
): void {
  const connection = useGemieRealtime();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!connection || !topic) return;
    const release = connection.follow(topic);
    const off = connection.on('agent.activity', (frame) => {
      if (frame.topic === topic) ref.current(frame);
    });
    return () => {
      off();
      release();
    };
  }, [connection, topic]);
}

/**
 * Hear the account's `activity` where no runtime provider holds the connection — an "Ask Alia"
 * button an app draws on its own (`useGemieActivity`). Inside a provider it does nothing: the
 * provider already feeds the store.
 */
export function useRealtimeActivityFeed(apiUrl: string): void {
  const inherited = useContext(RealtimeContext) !== null;
  const connection = useHeldConnection(apiUrl, !inherited);
  useEffect(() => {
    if (!connection) return;
    return attachActivity(connection);
  }, [connection]);
}
