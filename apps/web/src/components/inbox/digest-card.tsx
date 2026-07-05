'use client';

// Morning digest — the out-of-hours handoff promise (SPEC §5): the agent told
// the client "a equipe te responde pela manhã"; this card is where the team
// finds out who is waiting, what got booked overnight, and what needs review.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CalendarCheck, ChevronDown, ChevronUp, FileClock, MessageCircle, Sunrise, UserRound } from 'lucide-react';
import { api } from '@/lib/api';
import type { MorningDigest } from '@/lib/types';
import { contactLabel } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function DigestCard({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const { data: digest } = useQuery({
    queryKey: ['digest'],
    queryFn: async () => (await api.get<MorningDigest>('/conversations/digest')).data,
  });

  if (!digest) return null;

  const counts = [
    { icon: MessageCircle, label: 'conversas', value: digest.activeConversations.length },
    { icon: CalendarCheck, label: 'agendamentos', value: digest.appointmentsBooked.length },
    { icon: UserRound, label: 'aguardando equipe', value: digest.pendingHandoffs.length },
    { icon: FileClock, label: 'rascunhos', value: digest.pendingDraftCount },
  ];
  const quiet = counts.every((c) => c.value === 0);

  return (
    <Card className="m-3">
      <CardHeader className="flex-row items-center justify-between space-y-0 py-3">
        <CardTitle className="flex items-center gap-2">
          <Sunrise className="h-4 w-4 text-primary" /> Resumo das últimas 16h
        </CardTitle>
        <Button variant="ghost" size="icon" onClick={() => setExpanded((v) => !v)}>
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
      </CardHeader>
      <CardContent className="pb-3">
        {quiet ? (
          <p className="text-xs text-muted-foreground">Noite tranquila — nada pendente.</p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {counts.map(({ icon: Icon, label, value }) => (
              <span key={label} className="flex items-center gap-1 text-xs text-muted-foreground">
                <Icon className="h-3.5 w-3.5" />
                <strong className="text-foreground">{value}</strong> {label}
              </span>
            ))}
          </div>
        )}

        {expanded && !quiet && (
          <div className="mt-3 flex flex-col gap-3 text-xs">
            {digest.pendingHandoffs.length > 0 && (
              <section>
                <h3 className="mb-1 font-semibold">Aguardando a equipe</h3>
                {digest.pendingHandoffs.map((h) => (
                  <button
                    key={h.conversationId}
                    className="block text-left text-primary hover:underline"
                    onClick={() => onOpenConversation(h.conversationId)}
                  >
                    {contactLabel(h.contactName, h.contactPhone)}
                  </button>
                ))}
              </section>
            )}
            {digest.appointmentsBooked.length > 0 && (
              <section>
                <h3 className="mb-1 font-semibold">Agendamentos</h3>
                {digest.appointmentsBooked.map((a) => (
                  <p key={a.appointmentId} className="text-muted-foreground">
                    {contactLabel(a.contactName, a.contactPhone)} — {a.serviceName} —{' '}
                    {format(new Date(a.startsAt), "EEE d MMM, HH:mm", { locale: ptBR })}
                  </p>
                ))}
              </section>
            )}
            {digest.activeConversations.length > 0 && (
              <section>
                <h3 className="mb-1 font-semibold">Conversas no período</h3>
                {digest.activeConversations.map((c) => (
                  <button
                    key={c.conversationId}
                    className="block text-left text-primary hover:underline"
                    onClick={() => onOpenConversation(c.conversationId)}
                  >
                    {contactLabel(c.contactName, c.contactPhone)}
                  </button>
                ))}
              </section>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
