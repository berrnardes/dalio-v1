'use client';

// The R$ metrics dashboard — Phase 5 (SPEC §7, DOCUMENTO-EXECUTIVO §1): the
// four hero metrics, each translated into reais. This screen is the renewal
// argument — the clinic owner opens it and sees what the product paid back
// this month, so the copy leads with money and keeps the caveats honest
// ("estimativa" where the number is one).
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { BotMessageSquare, CalendarCheck2, HeartHandshake, MoonStar, Zap } from 'lucide-react';
import type { MetricsSummary } from '@dalio/shared';
import { api } from '@/lib/api';
import { formatBRL, formatDuration } from '@/lib/format';
import { AuthGate } from '@/components/auth-gate';
import { AppHeader } from '@/components/app-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

export default function MetricsPage() {
  return (
    <AuthGate>
      <div className="flex h-screen flex-col">
        <AppHeader />
        <main className="min-h-0 flex-1 overflow-y-auto bg-background">
          <Dashboard />
        </main>
      </div>
    </AuthGate>
  );
}

/** Current month + the 5 before it, newest first — enough for a pilot's history. */
function recentMonths(): { value: string; label: string }[] {
  const now = new Date();
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return {
      value: format(d, 'yyyy-MM'),
      label: format(d, 'MMMM yyyy', { locale: ptBR }),
    };
  });
}

function Dashboard() {
  const months = useMemo(recentMonths, []);
  const [month, setMonth] = useState(months[0]!.value);

  const { data, isLoading } = useQuery({
    queryKey: ['metrics', month],
    queryFn: async () =>
      (await api.get<MetricsSummary>('/metrics/summary', { params: { month } })).data,
  });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Quanto o Dalio devolveu</h1>
          <p className="text-sm text-muted-foreground">
            As quatro fontes de receita defendidas neste mês, em reais.
          </p>
        </div>
        <select
          className="rounded-md border border-border bg-card px-3 py-1.5 text-sm capitalize"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        >
          {months.map((m) => (
            <option key={m.value} value={m.value} className="capitalize">
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {isLoading || !data ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : (
        <HeroCards summary={data} />
      )}
    </div>
  );
}

function HeroCards({ summary }: { summary: MetricsSummary }) {
  const { autonomousBookings, recoveredNoShows, firstResponse, afterHoursLeads, reactivatedClients } =
    summary;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <HeroCard
        icon={BotMessageSquare}
        title="Agendamentos pelo agente"
        value={formatBRL(autonomousBookings.cents)}
        detail={`${autonomousBookings.count} ${plural(autonomousBookings.count, 'horário agendado', 'horários agendados')} sem ninguém da equipe na conversa`}
      />
      <HeroCard
        icon={CalendarCheck2}
        title="No-shows evitados"
        value={formatBRL(recoveredNoShows.estimatedCents)}
        badge="estimativa"
        detail={`${recoveredNoShows.count} ${plural(recoveredNoShows.count, 'horário confirmado', 'horários confirmados')} via lembrete × ${recoveredNoShows.noShowRatePct}% de taxa média de falta`}
      />
      <HeroCard
        icon={Zap}
        title="Tempo de 1ª resposta"
        value={firstResponse.medianSeconds === null ? '—' : formatDuration(firstResponse.medianSeconds)}
        detail={
          firstResponse.medianSeconds === null
            ? 'Sem leads respondidos no mês ainda'
            : `mediana · ${firstResponse.underSixtySecondsPct}% em menos de 1 minuto (${firstResponse.conversationsMeasured} ${plural(firstResponse.conversationsMeasured, 'lead', 'leads')})`
        }
      />
      <HeroCard
        icon={MoonStar}
        title="Leads fora do horário"
        value={formatBRL(afterHoursLeads.cents)}
        detail={`${afterHoursLeads.count} ${plural(afterHoursLeads.count, 'lead atendido', 'leads atendidos')} com a clínica fechada · ${afterHoursLeads.convertedCount} ${plural(afterHoursLeads.convertedCount, 'virou agendamento', 'viraram agendamento')}`}
      />
      <HeroCard
        icon={HeartHandshake}
        title="Clientes reativados"
        value={formatBRL(reactivatedClients.cents)}
        detail={`${reactivatedClients.count} ${plural(reactivatedClients.count, 'cliente antigo voltou', 'clientes antigos voltaram')} a agendar após campanha de reativação`}
      />
    </div>
  );
}

function HeroCard(props: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  value: string;
  detail: string;
  badge?: string;
}) {
  const { icon: Icon, title, value, detail, badge } = props;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon className="h-4 w-4 text-primary" />
          {title}
        </CardTitle>
        {badge && <Badge variant="secondary">{badge}</Badge>}
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-bold tracking-tight">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
