import {
  action,
  type ActionView,
  entity,
  list,
  type RecordView,
  skip,
  source,
  useEntities,
  useList,
  useListState,
  useStore,
  withStore,
} from '@oxy.so/bloom-data';
import { useOxy } from '@oxy.so/services/ui/client';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useRealtimeEvent, useRealtimeReset } from '../realtime/react';
import { type GemieApi, useGemieApi } from './api';
import { useGemieRuntime } from './config';
import { answerSource, useAnswer } from './data/answer';
import { ACCOUNT, gemieRead } from './data/read';
import { useBoundAction } from './use-bound-action';

/**
 * Connectors (`@gemies/sdk/connectors`): the providers' own remote MCP servers a person connects —
 * Notion, Linear, Slack… — and their own MCP servers by URL. One person may connect several
 * accounts of one connector; each account is its own connection, with its own tools
 * (`mcp_notion__…`, `mcp_notion_2__…`) and its own grants to gemies, so which account a tool acts
 * on is always explicit.
 *
 * The store (`GemieConnectorsStore`) is where a person finds and connects one: the providers'
 * servers Gemies curates, and the remote servers synced from the official MCP Registry, each with
 * its badge (`official`, `verified`, `community`). Settings (`GemieConnectedConnectors`) lists only
 * what they connected. Both, and every logo (`ConnectorLogo`), are the same in the Gemies and the
 * Alia apps.
 */

/** The routes, on the Gemies API (credentialed, the Gemies and Alia origins). */
export const CONNECTOR_ROUTES = {
  catalogue: '/mcp/registry',
  connected: '/mcp/installed',
  connect: '/mcp/connect',
  custom: '/mcp/custom',
  complete: '/mcp/oauth/complete',
  connection: (id: string) => `/mcp/${encodeURIComponent(id)}`,
  reconnect: (id: string) => `/mcp/${encodeURIComponent(id)}/reconnect`,
} as const;

export const CONNECTOR_CATEGORIES = [
  'productivity',
  'development',
  'communication',
  'data',
  'design',
  'finance',
  'marketing',
  'commerce',
  'search',
  'other',
] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

/**
 * Who stands behind a connector: `official` is the provider's own server (curated by Gemies, or
 * published by a domain its publisher proved and reached on it), `verified` a proven domain's server
 * reached elsewhere, `community` a server published by a GitHub account.
 */
export const CONNECTOR_TRUST = ['official', 'verified', 'community'] as const;
export type ConnectorTrust = (typeof CONNECTOR_TRUST)[number];

export const CONNECTOR_SORTS = ['featured', 'name', 'recent'] as const;
export type ConnectorSort = (typeof CONNECTOR_SORTS)[number];

/** A connector of the store: a remote MCP server this deployment can connect. */
export interface ConnectorEntry {
  id: string;
  name: string;
  description: string;
  category: ConnectorCategory;
  featured: boolean;
  trust: ConnectorTrust;
  /** `curated` by Gemies, or the catalogue it was synced from: the official MCP Registry, Docker's. */
  source: 'curated' | 'mcp_registry' | 'docker';
  /** `oauth` opens the provider's sign-in; `none` connects at once. */
  signIn: 'oauth' | 'none';
  /** How many tools it offers, when known before connecting. */
  toolCount: number | null;
  /** Where to read about it; `null` when its publisher gave no page. */
  docsUrl: string | null;
  /** On the API's origin; `null` draws a monogram. */
  logoUrl: string | null;
}

/** What the store shows: a search, a category, badges, only what needs no sign-in, an order. */
export interface ConnectorStoreQuery {
  q?: string;
  category?: ConnectorCategory;
  trust?: readonly ConnectorTrust[];
  noSignIn?: boolean;
  sort?: ConnectorSort;
}

/** One page of the store, and each category's count under the same search and filters. */
export interface ConnectorStorePage {
  servers: ConnectorEntry[];
  total: number;
  nextOffset: number | null;
  categories: { id: ConnectorCategory; count: number }[];
}

export type ConnectionStatus = 'installed' | 'running' | 'error';

/** One account a person connected. */
export interface Connection {
  _id: string;
  /** Its slug, which names its tools (`mcp_<name>__…`). */
  name: string;
  displayName: string;
  description: string | null;
  /** Which account of the provider (`ana@acme.com`, "Work"); `null` when the only one has none. */
  accountLabel: string | null;
  source: 'registry' | 'custom';
  registryId: string | null;
  config: { url?: string; requiresOAuth?: boolean };
  /** `running` is connected; `error` needs reconnecting; `installed` never finished connecting. */
  status: ConnectionStatus;
  statusMessage: string | null;
  tools: { name: string; description: string }[];
  logoUrl: string | null;
  /** The person's gemies that may use it: Alia every one, the others as granted. */
  usedBy: { id: string; name: string }[];
}

/** How many entries one page of the store asks for. */
export const CONNECTOR_STORE_PAGE_SIZE = 30;

/** The query string the store route reads (`GET /mcp/registry`). */
export function connectorStoreParams(
  query: ConnectorStoreQuery,
  offset: number,
  limit = CONNECTOR_STORE_PAGE_SIZE,
): Record<string, string | number> {
  return {
    ...(query.q?.trim() ? { q: query.q.trim() } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.trust?.length ? { trust: query.trust.join(',') } : {}),
    ...(query.noSignIn ? { signIn: 'none' } : {}),
    ...(query.sort ? { sort: query.sort } : {}),
    offset,
    limit,
  };
}

/** The store's connectors, by id: one record serves every search that lists it. */
export const ConnectorEntries = entity<ConnectorEntry>('gemies.connector', {
  id: (entry) => entry.id,
});

/** What a store list keeps beside its entries: the count and each category's, under its search. */
export interface ConnectorStoreExtra {
  total: number;
  categories: ConnectorStorePage['categories'];
}

/** The store's lists, one per search, filters and order (`connectorStoreKey`); memory only. */
export const ConnectorStoreList = list<ConnectorStoreExtra>('gemies.connector-store', {
  of: ConnectorEntries,
});

/** The key of a store query: equal searches share one list. */
export function connectorStoreKey(query: ConnectorStoreQuery): string {
  return JSON.stringify(connectorStoreParams(query, 0));
}

/** The store, a page at a time (by offset), searched, filtered and sorted by the API. */
export const connectorStore = source(ConnectorStoreList, {
  ...gemieRead,
  key: (_api: GemieApi, query: ConnectorStoreQuery) => connectorStoreKey(query),
  stale: 5 * 60_000,
  load: async ({ cursor, signal }, api, query) => {
    const { data } = await api.get<ConnectorStorePage>(CONNECTOR_ROUTES.catalogue, {
      signal,
      params: connectorStoreParams(query, cursor === undefined ? 0 : Number(cursor)),
    });
    return {
      items: data.servers,
      next: data.nextOffset === null ? null : String(data.nextOffset),
      extra: { total: data.total, categories: data.categories },
    };
  },
  // The first page's count and categories describe the whole search.
  fold: (current, extra, mode) =>
    (mode === 'next' ? current : extra) ?? { total: 0, categories: [] },
});

/** The store as a screen reads it. */
export interface ConnectorStoreView {
  readonly entries: readonly ConnectorEntry[];
  readonly total: number;
  readonly categories: ConnectorStorePage['categories'];
  /** Nothing to show yet: no answer for this search, and none for an earlier one. */
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly hasMore: boolean;
  readonly isLoadingMore: boolean;
  readonly more: () => Promise<void>;
  readonly refresh: () => Promise<void>;
}

/**
 * The store, a page at a time: hundreds of connectors are searched, filtered and sorted by the API,
 * and a new search keeps the previous results on screen until its own arrive.
 */
export function useConnectorStore(query: ConnectorStoreQuery): ConnectorStoreView {
  const api = useGemieApi();
  const { canUsePrivateApi } = useOxy();
  const view = useList(connectorStore, ...(canUsePrivateApi ? [api, query] : [skip]));
  // The last search that answered, shown while a new one has no answer yet.
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (view.list) setShown(view.key);
  }, [view.list, view.key]);
  const previous = useListState(ConnectorStoreList, view.list ? null : shown);
  const held = view.list ?? previous;
  const entries = useEntities(ConnectorEntries, held?.ids ?? []);
  return {
    entries: useMemo(
      () => entries.filter((entry): entry is ConnectorEntry => entry !== undefined),
      [entries],
    ),
    total: held?.extra?.total ?? 0,
    categories: held?.extra?.categories ?? [],
    isLoading: held === undefined && view.isLoading,
    isError: view.status === 'error',
    hasMore: view.hasMore,
    isLoadingMore: view.isFetching && view.list !== undefined,
    more: view.more,
    refresh: view.refresh,
  };
}

/**
 * What the person connected, each account on its own: memory only, read again when the realtime
 * `connections` event says it changed, and after a reset.
 */
export const connections = answerSource('gemies.connections', {
  ...gemieRead,
  key: (_api: GemieApi) => ACCOUNT,
  stale: 30_000,
  load: async ({ signal }, api) =>
    (await api.get<{ servers: Connection[] }>(CONNECTOR_ROUTES.connected, { signal })).data.servers,
});

/**
 * What the person connected, each account on its own. `enabled: false` reads nothing: the chat is
 * embedded in apps whose origin the connector routes do not answer, and asks only for a turn that
 * used a connector.
 */
export function useConnections({
  enabled = true,
}: {
  enabled?: boolean;
} = {}): RecordView<Connection[]> {
  const api = useGemieApi();
  const { canUsePrivateApi } = useOxy();
  const view = useAnswer(connections, ...(canUsePrivateApi && enabled ? [api] : [skip]));
  useRealtimeEvent('connections', () => void view.refresh());
  useRealtimeReset(() => void view.refresh());
  return view;
}

/** A logo path the API answered, as a URL on its origin. */
export function useConnectorLogoUrl(logoUrl: string | null | undefined): string | null {
  const { apiUrl } = useGemieRuntime();
  if (!logoUrl) return null;
  return logoUrl.startsWith('/') ? `${apiUrl.replace(/\/$/, '')}${logoUrl}` : null;
}

/**
 * Open the provider's sign-in. On the web the page itself goes there, and comes back to `returnTo`
 * with the result in its query (read by `useCompleteConnectorSignIn`). In the native app an auth
 * session waits for the app's own scheme and hands back the URL it returned to.
 */
async function openSignIn(authorizationUrl: string, returnTo: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    window.location.assign(authorizationUrl);
    return null;
  }
  const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, returnTo);
  return result.type === 'success' ? result.url : null;
}

/** `state` and `code` (or the error) from the URL a sign-in returned to. */
export function signInResult(
  params: Record<string, string | string[] | undefined> | URLSearchParams,
): { state: string; code: string } | { error: string } | null {
  const read = (key: string) => {
    const value = params instanceof URLSearchParams ? params.get(key) : params[key];
    return typeof value === 'string' && value ? value : undefined;
  };
  const error = read('mcp_oauth_error');
  if (error) return { error };
  const state = read('mcp_oauth_state');
  const code = read('mcp_oauth_code');
  return state && code ? { state, code } : null;
}

export interface ConnectorActionsOptions {
  /**
   * Where the provider sends the person back: on the web a page of this app (the current one by
   * default), in the native app its scheme (`gemies://connectors`, `alia://connectors`).
   */
  returnTo: string;
}

/** Draws a change to the held connections, as the calling action's layer. */
function drawConnections(change: (held: Connection[]) => Connection[]): void {
  connections.entity.update(ACCOUNT, (held) => ({ ...held, value: change([...held.value]) }));
}

/** Every write ends with the connections read again, so each screen shows them as they are. */
const rereadConnections = (api: GemieApi) => void connections.refresh(api);

/** Finishes a provider's sign-in with what it returned (`state`, `code`): the connection it made. */
export const completeConnectorSignIn = action({
  run: async (api: GemieApi, result: { state: string; code: string }) =>
    (await api.post<{ server: Connection }>(CONNECTOR_ROUTES.complete, result)).data.server,
  settle: (_connection, api) => rereadConnections(api),
});

/** What a connection through a provider's sign-in needs: the API, and where the sign-in returns. */
export interface ConnectorClient {
  api: GemieApi;
  returnTo: string;
}

/** Sign in at the provider, and finish here when the native session hands the result back. */
async function signIn(
  { api, returnTo }: ConnectorClient,
  authorizationUrl: string,
): Promise<Connection | null> {
  const returned = await openSignIn(authorizationUrl, returnTo);
  if (!returned) return null;
  const result = signInResult(new URL(returned).searchParams);
  if (!result) return null;
  if ('error' in result) throw new Error(result.error);
  return (await api.post<{ server: Connection }>(CONNECTOR_ROUTES.complete, result)).data.server;
}

/** A new account: through the provider's sign-in, or at once for a server that needs none. */
export const connectConnector = action({
  run: async (client: ConnectorClient, registryId: string) => {
    const { data } = await client.api.post<{ authorizationUrl?: string; server?: Connection }>(
      CONNECTOR_ROUTES.connect,
      { registryId, returnTo: client.returnTo },
    );
    if (data.authorizationUrl) return signIn(client, data.authorizationUrl);
    return data.server ?? null;
  },
  settle: (_connection, client) => rereadConnections(client.api),
});

export interface CustomConnectorInput {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

/** The person's own MCP server, by URL; through its sign-in when it has one. */
export const addCustomConnector = action({
  run: async (client: ConnectorClient, input: CustomConnectorInput) => {
    const { data } = await client.api.post<{ server: Connection; authorizationUrl?: string }>(
      CONNECTOR_ROUTES.custom,
      { ...input, returnTo: client.returnTo },
    );
    return data.authorizationUrl ? signIn(client, data.authorizationUrl) : data.server;
  },
  settle: (_connection, client) => rereadConnections(client.api),
});

/** Connects an account again, through its provider's sign-in when it needs one. */
export const reconnectConnector = action({
  run: async (client: ConnectorClient, id: string) => {
    const { data } = await client.api.post<{ server: Connection; authorizationUrl?: string }>(
      CONNECTOR_ROUTES.reconnect(id),
      { returnTo: client.returnTo },
    );
    return data.authorizationUrl ? signIn(client, data.authorizationUrl) : data.server;
  },
  settle: (_connection, client) => rereadConnections(client.api),
});

/** Names which account of the provider a connection is: drawn at once, put back if refused. */
export const renameConnector = action({
  optimistic: (_api: GemieApi, id: string, accountLabel: string | null) =>
    drawConnections((held) => held.map((c) => (c._id === id ? { ...c, accountLabel } : c))),
  run: async (api, id, accountLabel) => {
    await api.patch(CONNECTOR_ROUTES.connection(id), { accountLabel });
  },
  settle: (_result, api) => rereadConnections(api),
});

/** Disconnects an account: gone at once, back if refused. */
export const disconnectConnector = action({
  optimistic: (_api: GemieApi, id: string) =>
    drawConnections((held) => held.filter((c) => c._id !== id)),
  run: async (api, id) => {
    await api.delete(CONNECTOR_ROUTES.connection(id));
  },
  settle: (_result, api) => rereadConnections(api),
});

/**
 * Connecting, adding a custom server, reconnecting, renaming and disconnecting, as a component calls
 * them. Each ends with the connections read again.
 */
export function useConnectorActions({ returnTo }: ConnectorActionsOptions): {
  connect: ActionView<[registryId: string], Connection | null>;
  addCustom: ActionView<[input: CustomConnectorInput], Connection | null>;
  reconnect: ActionView<[id: string], Connection | null>;
  rename: ActionView<[id: string, accountLabel: string | null], void>;
  disconnect: ActionView<[id: string], void>;
} {
  const api = useGemieApi();
  const client = useMemo<ConnectorClient>(() => ({ api, returnTo }), [api, returnTo]);
  return {
    connect: useBoundAction(connectConnector, client),
    addCustom: useBoundAction(addCustomConnector, client),
    reconnect: useBoundAction(reconnectConnector, client),
    rename: useBoundAction(renameConnector, api),
    disconnect: useBoundAction(disconnectConnector, api),
  };
}

/** The connector slug a tool name carries: `mcp_notion_2__search` → `notion_2`. */
function toolSlug(toolName: string | undefined): string | undefined {
  if (!toolName?.startsWith('mcp_')) return undefined;
  const end = toolName.indexOf('__');
  return end > 4 ? toolName.slice(4, end) : undefined;
}

/**
 * The account a tool name belongs to: `mcp_notion_2__search` is the connection whose slug is
 * `notion_2` (the API builds tool names from the slug with every other character as `_`).
 */
export function connectionOfTool(
  connections: readonly Connection[] | undefined,
  toolName: string | undefined,
): Connection | undefined {
  const slug = toolSlug(toolName);
  if (!slug) return undefined;
  return connections?.find((connection) => connection.name.replace(/[^a-zA-Z0-9]/g, '_') === slug);
}

/**
 * The connector, and which of the person's accounts, a tool name belongs to; `undefined` for a
 * tool that is not a connector's, or while the list is unread. The list is read only for a
 * connector's tool.
 */
export function useConnectionOfTool(toolName: string | undefined): Connection | undefined {
  const { value } = useConnections({ enabled: toolSlug(toolName) !== undefined });
  return connectionOfTool(value, toolName);
}

/** The copy key that says why a sign-in did not connect (`mcp_oauth_error`, or `failed`). */
export function signInErrorKey(error: string): string {
  if (error === 'access_denied') return 'gemie.connectors.signIn.declined';
  if (error === 'expired') return 'gemie.connectors.signIn.expired';
  return 'gemie.connectors.signIn.failedGeneric';
}

/** The store's path in every app that draws it: where a web sign-in comes back to. */
export const CONNECTORS_PATH = '/connectors';

/**
 * Where the provider sends the person back after signing in: the connectors store, which finishes
 * it (`useWebSignInReturn`). On the web its page on this origin; in the native app its deep link
 * on the app's own scheme (`gemies://connectors`), which the auth session is waiting for.
 */
export function connectorReturnTo(nativeScheme: string): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `${window.location.origin}${CONNECTORS_PATH}`;
  }
  return `${nativeScheme}:/${CONNECTORS_PATH}`;
}

/**
 * On the web, finish the sign-in the store's page came back from: the provider returned the person here
 * with `mcp_oauth_state` and `mcp_oauth_code` (or `mcp_oauth_error`) in the query. Each is finished
 * once, the query is cleared, and `onDone` hears how it went. Native sign-ins finish in place
 * (`useConnectorActions`), so this does nothing there.
 */
export function useWebSignInReturn(
  onDone: (outcome: { ok: true; connection: Connection } | { ok: false; error: string }) => void,
) {
  const api = useGemieApi();
  const store = useStore();
  const handled = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || handled.current) return;
    const query = new URLSearchParams(window.location.search);
    const result = signInResult(query);
    if (!result) return;
    handled.current = true;
    for (const key of ['mcp_oauth_state', 'mcp_oauth_code', 'mcp_oauth_error']) query.delete(key);
    const rest = query.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`,
    );
    if ('error' in result) {
      onDone({ ok: false, error: result.error });
      return;
    }
    withStore(store, () => completeConnectorSignIn(api, result))
      .then((connection) =>
        onDone(connection ? { ok: true, connection } : { ok: false, error: 'failed' }),
      )
      .catch(() => onDone({ ok: false, error: 'failed' }));
    // Once per page load: the query is cleared as soon as it is read.
  }, []);
}
