'use client';

// Live inbox — SSE consumer of GET /conversations/stream (SPEC §7). Events
// are id-pointers (never content — see packages/shared/src/inbox.ts): this
// hook only invalidates react-query caches; the refetch over authenticated
// REST is what carries data. EventSource reconnects on its own after drops.
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { InboxEvent } from '@dalio/shared';
import { API_URL } from '@/lib/api';

export function useInboxStream() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const source = new EventSource(`${API_URL}/api/v1/conversations/stream`, {
      withCredentials: true, // the Better-auth session cookie IS the auth
    });

    source.onmessage = (e) => {
      const event = JSON.parse(e.data as string) as InboxEvent;
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['digest'] });
      if (event.type === 'message') {
        void queryClient.invalidateQueries({ queryKey: ['messages', event.conversationId] });
      }
      void queryClient.invalidateQueries({ queryKey: ['conversation', event.conversationId] });
    };

    return () => source.close();
  }, [queryClient]);
}
