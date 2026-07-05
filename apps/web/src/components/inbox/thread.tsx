'use client';

// Thread pane: timeline, supervised-draft approval, composer, pause/resume.
// Sending a human reply auto-pauses the agent server-side (takeover); the UI
// reflects it immediately via the conversation event on the SSE stream.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, ChevronUp, PauseCircle, PlayCircle, SendHorizonal, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { ConversationListItem, Message } from '@/lib/types';
import { SOURCE_LABELS, contactLabel, isPaused, messageText, messageTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;

export function Thread({ conversation }: { conversation: ConversationListItem }) {
  const queryClient = useQueryClient();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  // Older pages accumulate under the live page as "Carregar anteriores" walks
  // the uuidv7 cursor back; the live page invalidates freely without
  // disturbing what was already loaded.
  const [olderPages, setOlderPages] = useState<Message[][]>([]);

  const { data: livePage, isPending } = useQuery({
    queryKey: ['messages', conversation.id],
    queryFn: async () =>
      (await api.get<Message[]>(`/conversations/${conversation.id}/messages?limit=${PAGE_SIZE}`))
        .data,
  });

  useEffect(() => setOlderPages([]), [conversation.id]);

  const messages = useMemo(
    () => [...olderPages.flat(), ...(livePage ?? [])],
    [olderPages, livePage],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [livePage]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['messages', conversation.id] });
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
  };

  const send = useMutation({
    mutationFn: async (body: string) =>
      api.post(`/conversations/${conversation.id}/messages`, { text: body }),
    onSuccess: () => {
      setText('');
      invalidate();
    },
  });

  const pauseResume = useMutation({
    mutationFn: async (action: 'pause' | 'resume') =>
      api.post(`/conversations/${conversation.id}/${action}`, {}),
    onSuccess: invalidate,
  });

  const draftAction = useMutation({
    mutationFn: async (params: { messageId: string; action: 'approve' | 'reject' }) =>
      api.post(`/conversations/${conversation.id}/drafts/${params.messageId}/${params.action}`),
    onSuccess: invalidate,
  });

  const loadOlder = async () => {
    const oldest = messages[0];
    if (!oldest) return;
    const { data } = await api.get<Message[]>(
      `/conversations/${conversation.id}/messages?limit=${PAGE_SIZE}&before=${oldest.id}`,
    );
    if (data.length > 0) setOlderPages((pages) => [data, ...pages]);
  };

  const paused = isPaused(conversation.pausedUntil);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (trimmed) send.mutate(trimmed);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header: who + agent state + explicit pause/resume */}
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">
            {contactLabel(conversation.contactName, conversation.contactPhone)}
          </h2>
          <p className="text-xs text-muted-foreground">{conversation.contactPhone}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {paused ? (
            <>
              <Badge variant="secondary">
                <PauseCircle className="h-3 w-3" /> Agente pausado
              </Badge>
              <Button
                size="sm"
                variant="outline"
                disabled={pauseResume.isPending}
                onClick={() => pauseResume.mutate('resume')}
              >
                <PlayCircle className="h-4 w-4" /> Reativar agente
              </Button>
            </>
          ) : (
            <>
              <Badge variant="success">
                <Bot className="h-3 w-3" /> Agente ativo
              </Badge>
              <Button
                size="sm"
                variant="outline"
                disabled={pauseResume.isPending}
                onClick={() => pauseResume.mutate('pause')}
              >
                <PauseCircle className="h-4 w-4" /> Pausar
              </Button>
            </>
          )}
        </div>
      </header>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto p-4">
        {isPending ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className={cn('h-12 w-2/3', i % 2 && 'self-end')} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {(livePage?.length ?? 0) >= PAGE_SIZE && (
              <Button variant="ghost" size="sm" className="self-center" onClick={() => void loadOlder()}>
                <ChevronUp className="h-4 w-4" /> Carregar anteriores
              </Button>
            )}
            {messages.map((m) =>
              m.status === 'draft' ? (
                <DraftCard
                  key={m.id}
                  message={m}
                  pending={draftAction.isPending}
                  onApprove={() => draftAction.mutate({ messageId: m.id, action: 'approve' })}
                  onReject={() => draftAction.mutate({ messageId: m.id, action: 'reject' })}
                />
              ) : (
                <Bubble key={m.id} message={m} />
              ),
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Composer */}
      <form onSubmit={onSubmit} className="border-t border-border p-3">
        {!paused && (
          <p className="mb-2 text-xs text-muted-foreground">
            Ao enviar, o agente é pausado automaticamente — a conversa passa a ser sua.
          </p>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            rows={2}
            placeholder="Escreva uma mensagem para o cliente…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSubmit(e);
              }
            }}
          />
          <Button type="submit" size="icon" disabled={send.isPending || !text.trim()}>
            <SendHorizonal className="h-4 w-4" />
          </Button>
        </div>
        {send.isError && (
          <p className="mt-1 text-xs text-destructive">Falha ao enviar. Tente novamente.</p>
        )}
      </form>
    </div>
  );
}

function Bubble({ message }: { message: Message }) {
  const inbound = message.direction === 'inbound';
  // Discarded drafts stay visible (struck through): the trust-ramp audit
  // trail — the team sees what the agent would have said.
  const discarded = message.status === 'discarded';
  return (
    <div
      className={cn(
        'max-w-[75%] rounded-lg border border-border px-3 py-2 shadow-sm',
        inbound ? 'self-start bg-bubble-in' : 'self-end bg-bubble-out',
        discarded && 'opacity-60',
      )}
    >
      <div className="mb-0.5 flex items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          {SOURCE_LABELS[message.source]}
        </span>
        <span className="text-[11px] text-muted-foreground">{messageTime(message.createdAt)}</span>
        {message.status === 'failed' && <Badge variant="destructive">falhou</Badge>}
        {discarded && <Badge variant="outline">descartado</Badge>}
      </div>
      <p className={cn('whitespace-pre-wrap text-sm', discarded && 'line-through')}>
        {messageText(message)}
      </p>
    </div>
  );
}

/** Supervised mode: the agent's suggestion awaiting a human decision. */
function DraftCard({
  message,
  pending,
  onApprove,
  onReject,
}: {
  message: Message;
  pending: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="max-w-[75%] self-end rounded-lg border border-draft-border bg-draft px-3 py-2 shadow-sm">
      <div className="mb-1 flex items-center gap-2">
        <Badge variant="warning">
          <Bot className="h-3 w-3" /> Rascunho do agente
        </Badge>
        <span className="text-[11px] text-muted-foreground">{messageTime(message.createdAt)}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm">{messageText(message)}</p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={pending} onClick={onApprove}>
          <Check className="h-4 w-4" /> Aprovar e enviar
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={onReject}>
          <X className="h-4 w-4" /> Descartar
        </Button>
      </div>
    </div>
  );
}
