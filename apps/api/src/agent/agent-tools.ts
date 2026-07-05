// Agent tools — SPEC §5: the booking node's hands. Built per turn as
// closures over the tenant-scoped services and the conversation's contact,
// so a tool can never book across clinics or for the wrong person (iron
// rule #1 extends into the LLM's reach). Tool results are strings the model
// reads — errors return honest messages, never throw through the graph.
import { TZDate } from '@date-fns/tz';
import { z } from 'zod';
import type { AppointmentLifecycleService } from '../reminders/appointment-lifecycle.service';
import type { AppointmentsRepository } from '../scheduling/appointments.repository';
import type { AvailabilityService } from '../scheduling/availability.service';

export interface AgentToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  execute(input: unknown): Promise<string>;
}

export interface AgentToolDeps {
  availability: AvailabilityService;
  appointmentsRepo: AppointmentsRepository;
  /** Writes go through the lifecycle so booking generates the reminder
   *  cadence and cancel/reschedule cancel it + backfill the waitlist. */
  lifecycle: AppointmentLifecycleService;
  contactId: string;
  timezone: string;
}

const formatLocal = (iso: string, tz: string): string => {
  const d = new TZDate(new Date(iso), tz);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function buildAgentTools(deps: AgentToolDeps): AgentToolDef[] {
  return [
    {
      name: 'get_available_slots',
      description:
        'Consulta os horários realmente livres para um serviço em uma data. Use SEMPRE antes de oferecer horários ao cliente.',
      schema: z.object({
        serviceId: z.string().describe('id do serviço, conforme o catálogo do sistema'),
        date: z.string().describe('data desejada no formato yyyy-MM-dd'),
      }),
      execute: async (input) => {
        const { serviceId, date } = input as { serviceId: string; date: string };
        try {
          const slots = await deps.availability.getSlots(serviceId, date);
          if (slots.length === 0) return `Nenhum horário livre em ${date}.`;
          // Cap the list: the model should offer 2-3 options, not paste a wall.
          const shown = slots.slice(0, 8);
          return JSON.stringify(
            shown.map((s) => ({ startsAtISO: s.startsAt, local: formatLocal(s.startsAt, deps.timezone) })),
          );
        } catch (err) {
          return `Erro ao consultar agenda: ${(err as Error).message}`;
        }
      },
    },
    {
      name: 'book_appointment',
      description:
        'Agenda um horário para o cliente. Use SOMENTE depois que o cliente confirmar explicitamente serviço, data e horário. startsAtISO deve vir de get_available_slots.',
      schema: z.object({
        serviceId: z.string().describe('id do serviço'),
        startsAtISO: z.string().describe('início do horário escolhido, ISO 8601 vindo de get_available_slots'),
      }),
      execute: async (input) => {
        const { serviceId, startsAtISO } = input as { serviceId: string; startsAtISO: string };
        const result = await deps.lifecycle.book({
          contactId: deps.contactId,
          serviceId,
          startsAtISO,
          source: 'agent',
        });
        if (!result.ok) {
          return result.reason === 'slot_taken'
            ? 'Esse horário acabou de ser ocupado. Consulte get_available_slots novamente e ofereça alternativas.'
            : `Não foi possível agendar: ${result.reason}`;
        }
        return `Agendado com sucesso para ${formatLocal(startsAtISO, deps.timezone)} (id ${result.appointmentId}).`;
      },
    },
    {
      name: 'get_my_appointments',
      description: 'Lista os próximos horários agendados deste cliente.',
      schema: z.object({}),
      execute: async () => {
        const rows = await deps.appointmentsRepo.listUpcomingByContact(deps.contactId);
        if (rows.length === 0) return 'Este cliente não tem horários futuros agendados.';
        return JSON.stringify(
          rows.map((r) => ({
            appointmentId: r.id,
            service: r.serviceName,
            local: formatLocal(r.startsAt.toISOString(), deps.timezone),
            status: r.status,
          })),
        );
      },
    },
    {
      name: 'cancel_appointment',
      description:
        'Cancela um horário agendado deste cliente. Use get_my_appointments antes para obter o appointmentId e confirme com o cliente qual horário cancelar.',
      schema: z.object({ appointmentId: z.string().describe('id do agendamento a cancelar') }),
      execute: async (input) => {
        const { appointmentId } = input as { appointmentId: string };
        const ok = await deps.lifecycle.cancel(appointmentId);
        return ok
          ? 'Horário cancelado com sucesso.'
          : 'Não encontrei um agendamento ativo com esse id.';
      },
    },
  ];
}
