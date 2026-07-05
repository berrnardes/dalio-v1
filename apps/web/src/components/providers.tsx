'use client';

// App-wide client providers: react-query is the single data layer — the SSE
// stream invalidates its caches, so components never poll.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // SSE invalidation is the freshness mechanism; window refocus
          // refetching on top of it just duplicates requests.
          queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
