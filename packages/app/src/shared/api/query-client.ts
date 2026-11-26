import { gemieRead } from '@gemies/sdk/runtime';
import { environment } from '@oxy.so/bloom-data';
import { onlineManager, QueryClient } from '@tanstack/react-query';

/**
 * The app's own React Query client, mounted above `OxyProvider` (`app/_layout.tsx`).
 *
 * Services 15 and `@gemies/sdk` 10 keep their data in the account's bloom-data store and no longer
 * own a React Query client, so every query in this client is the app's. They live in memory only:
 * what a returning person must see from the first frame is a bloom-data answer persisted in the
 * account's store (`useMyAgents`, `useSpaces`), never a persisted query cache.
 *
 * The defaults are the ones Services' client gave the app's queries before: fresh for five
 * minutes, retried as every Gemies read is (`gemieRead`: only what another attempt can change, at
 * most twice, honouring `Retry-After`), not read again on focus (the realtime connection keeps what
 * is on screen current), and offline first, so a write made offline waits for the network.
 *
 * React Query counts the first failure as 0 and bloom-data as 1, hence the `+ 1`.
 */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
        retry: (failureCount, error) => gemieRead.retry(failureCount + 1, error),
        retryDelay: (failureCount, error) => gemieRead.retryDelay(failureCount + 1, error),
        refetchOnReconnect: true,
        refetchOnWindowFocus: false,
        networkMode: 'offlineFirst',
      },
      mutations: { retry: false, networkMode: 'offlineFirst' },
    },
  });
}

/**
 * React Query hears connectivity from bloom-data's `environment`, which `OxyProvider` feeds from
 * NetInfo on a device and the browser feeds on the web: one answer to "is the device online" for
 * the account's store and the app's queries, so a paused write resumes when the reads do.
 */
export function followDataEnvironment(): void {
  onlineManager.setEventListener((setOnline) => {
    setOnline(environment.online);
    return environment.subscribe((event) => {
      if (event === 'online' || event === 'offline') setOnline(event === 'online');
    });
  });
}
