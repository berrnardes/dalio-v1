'use client';

// Conversation cards (left pane). Attention hierarchy: pending drafts and
// paused threads (a human owns them) must pop before anything else — this is
// the clinic's only human channel, so "what needs me?" is the whole job.
import { useQuery } from '@tanstack/react-query';
import { Bot, FileClock, PauseCircle } from 'lucide-react';
import { api } from '@/lib/api';
import type { ConversationListItem } from '@/lib/types';
import { contactLabel, isPaused, relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function useConversations() {
  return useQuery({
    queryKey: ['conversations'],
    queryFn: async () => (await api.get<ConversationListItem[]>('/conversations')).data,
  });
}

export function ConversationList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { data: conversations, isPending } = useConversations();

  if (isPending) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (!conversations?.length) {
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">
        Nenhuma conversa ainda. Quando um cliente escrever no WhatsApp, ela aparece aqui.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {conversations.map((c) => {
        const paused = isPaused(c.pausedUntil);
        return (
          <li key={c.id}>
            <button
              onClick={() => onSelect(c.id)}
              className={cn(
                'flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-accent',
                selectedId === c.id && 'bg-accent',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">
                  {contactLabel(c.contactName, c.contactPhone)}
                </span>
                {c.lastInboundAt && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {relativeTime(c.lastInboundAt)}
                  </span>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {c.lastMessage?.preview ?? '—'}
              </p>
              <div className="flex items-center gap-1.5">
                {c.pendingDrafts > 0 && (
                  <Badge variant="warning">
                    <FileClock className="h-3 w-3" />
                    {c.pendingDrafts} rascunho{c.pendingDrafts > 1 ? 's' : ''}
                  </Badge>
                )}
                {paused ? (
                  <Badge variant="secondary">
                    <PauseCircle className="h-3 w-3" /> Agente pausado
                  </Badge>
                ) : (
                  <Badge variant="success">
                    <Bot className="h-3 w-3" /> Agente ativo
                  </Badge>
                )}
                {c.optedOut && <Badge variant="destructive">Opt-out</Badge>}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
