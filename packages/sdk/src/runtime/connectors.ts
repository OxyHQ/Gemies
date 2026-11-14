import { useOxy } from '@oxy.so/services/ui/client';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useGemieApi } from './api';
import { useGemieRuntime } from './config';

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

export const connectorQueryKeys = {
  catalogue: ['gemie-connectors', 'catalogue'] as const,
  store: (query: ConnectorStoreQuery) => ['gemie-connectors', 'catalogue', query] as const,
  connected: ['gemie-connectors', 'connected'] as const,
};

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

/**
 * The store, a page at a time: hundreds of connectors are searched, filtered and sorted by the API,
 * and a new search keeps the previous results on screen until the next arrive.
 */
export function useConnectorStore(query: ConnectorStoreQuery) {
  const api = useGemieApi();
  const { isAuthenticated } = useOxy();
  return useInfiniteQuery({
    queryKey: connectorQueryKeys.store(query),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<ConnectorStorePage>(CONNECTOR_ROUTES.catalogue, {
          params: connectorStoreParams(query, pageParam),
        })
      ).data,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    enabled: isAuthenticated,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * What the person connected, each account on its own. `enabled: false` reads nothing: the chat is
 * embedded in apps whose origin the connector routes do not answer, and asks only for a turn that
 * used a connector.
 */
export function useConnections({ enabled = true }: { enabled?: boolean } = {}) {
  const api = useGemieApi();
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: connectorQueryKeys.connected,
    queryFn: async () =>
      (await api.get<{ servers: Connection[] }>(CONNECTOR_ROUTES.connected)).data.servers,
    enabled: isAuthenticated && enabled,
    staleTime: 30_000,
  });
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

/**
 * Connecting, adding a custom server, reconnecting, renaming and disconnecting. Each ends with the
 * lists read again, so every screen that shows a connector shows it as it is.
 */
export function useConnectorActions({ returnTo }: ConnectorActionsOptions) {
  const api = useGemieApi();
  const queryClient = useQueryClient();
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: connectorQueryKeys.connected }),
    [queryClient],
  );

  const complete = useMutation({
    mutationFn: async (input: { state: string; code: string }) =>
      (await api.post<{ server: Connection }>(CONNECTOR_ROUTES.complete, input)).data.server,
    onSuccess: refresh,
  });

  /** Sign in at the provider, and finish here when the native session hands the result back. */
  const signIn = async (authorizationUrl: string): Promise<Connection | null> => {
    const returned = await openSignIn(authorizationUrl, returnTo);
    if (!returned) return null;
    const result = signInResult(new URL(returned).searchParams);
    if (!result) return null;
    if ('error' in result) throw new Error(result.error);
    return complete.mutateAsync(result);
  };

  /** A new account: through the provider's sign-in, or at once for a server that needs none. */
  const connect = useMutation({
    mutationFn: async (registryId: string) => {
      const { data } = await api.post<{ authorizationUrl?: string; server?: Connection }>(
        CONNECTOR_ROUTES.connect,
        { registryId, returnTo },
      );
      if (data.authorizationUrl) return signIn(data.authorizationUrl);
      await refresh();
      return data.server ?? null;
    },
  });

  const addCustom = useMutation({
    mutationFn: async (input: { name: string; url: string; headers?: Record<string, string> }) => {
      const { data } = await api.post<{ server: Connection; authorizationUrl?: string }>(
        CONNECTOR_ROUTES.custom,
        { ...input, returnTo },
      );
      await refresh();
      return data.authorizationUrl ? signIn(data.authorizationUrl) : data.server;
    },
  });

  const reconnect = useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<{ server: Connection; authorizationUrl?: string }>(
        CONNECTOR_ROUTES.reconnect(id),
        { returnTo },
      );
      if (!data.authorizationUrl) {
        await refresh();
        return data.server;
      }
      return signIn(data.authorizationUrl);
    },
  });

  const rename = useMutation({
    mutationFn: async (input: { id: string; accountLabel: string | null }) => {
      await api.patch(CONNECTOR_ROUTES.connection(input.id), { accountLabel: input.accountLabel });
    },
    onSuccess: refresh,
  });

  const disconnect = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(CONNECTOR_ROUTES.connection(id));
    },
    onSuccess: refresh,
  });

  return { connect, addCustom, reconnect, rename, disconnect, complete };
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
  const { data } = useConnections({ enabled: toolSlug(toolName) !== undefined });
  return connectionOfTool(data, toolName);
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
  const queryClient = useQueryClient();
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
    api
      .post<{ server: Connection }>(CONNECTOR_ROUTES.complete, result)
      .then(async ({ data }) => {
        await queryClient.invalidateQueries({ queryKey: connectorQueryKeys.connected });
        onDone({ ok: true, connection: data.server });
      })
      .catch(() => onDone({ ok: false, error: 'failed' }));
    // Once per page load: the query is cleared as soon as it is read.
  }, []);
}
