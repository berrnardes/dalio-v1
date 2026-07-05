// Supervised mode (Phase 3) — the pilot trust ramp: agent replies must park
// as drafts, NEVER reach the outbox... except the deterministic opt-out
// confirmation, which is LGPD machinery and bypasses human approval. Also
// guards the history allowlist: drafts/discarded rows must be invisible to
// the model (a leaked draft reads as something the agent already "said").
import { describe, expect, it } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { AgentTurnHandler } from '../src/agent/agent-turn.handler';
import type { AgentModels } from '../src/agent/agent-models';
import type {
  ConversationsRepository,
  MessageRow,
} from '../src/conversations/conversations.repository';
import type { ContactsRepository } from '../src/conversations/contacts.repository';
import type { ClinicsRepository } from '../src/scheduling/clinics.repository';
import type { ServicesRepository } from '../src/catalog/services.repository';
import type { AvailabilityService } from '../src/scheduling/availability.service';
import type { AppointmentsRepository } from '../src/scheduling/appointments.repository';
import type { OutboxService } from '../src/outbound/outbox.service';
import type { InboxEventsService } from '../src/inbox/inbox-events.service';
import type { TurnInput } from '../src/conversations/turn-handler';

class FaqModels implements AgentModels {
  readonly configured = true;
  faqHistories: BaseMessage[][] = [];

  invokeRouter(): Promise<AIMessage> {
    return Promise.resolve(new AIMessage('{"intent":"faq"}'));
  }
  invokeFaq(messages: BaseMessage[]): Promise<AIMessage> {
    this.faqHistories.push([...messages]);
    return Promise.resolve(new AIMessage('Custa R$ 180!'));
  }
  invokeBooking(): Promise<AIMessage> {
    throw new Error('booking must not run in these scenarios');
  }
}

function makeHandler(opts: {
  supervised?: boolean;
  history?: MessageRow[];
  flowContext?: unknown;
}) {
  const calls = {
    drafts: [] as Array<Record<string, unknown>>,
    sends: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
    flowContexts: [] as unknown[],
    lifecycle: [] as Array<{ op: string; appointmentId: string }>,
    optOuts: 0,
  };
  const models = new FaqModels();

  const conversationsRepo = {
    getById: () =>
      Promise.resolve({
        id: 'convo-1',
        clinicId: 'clinic-1',
        contactId: 'contact-1',
        channelId: 'channel-1',
        status: 'open',
        pausedUntil: null,
        flowContext: opts.flowContext ?? null,
      }),
    listRecentMessages: () => Promise.resolve(opts.history ?? []),
    appendOutboundDraft: (params: Record<string, unknown>) => {
      calls.drafts.push(params);
      return Promise.resolve({ id: `draft-${calls.drafts.length}` });
    },
    setFlowContext: (_id: string, flow: unknown) => {
      calls.flowContexts.push(flow);
      return Promise.resolve();
    },
    pause: () => Promise.resolve(),
  } as unknown as ConversationsRepository;

  const lifecycle = {
    confirm: (appointmentId: string) => {
      calls.lifecycle.push({ op: 'confirm', appointmentId });
      return Promise.resolve(true);
    },
    cancel: (appointmentId: string) => {
      calls.lifecycle.push({ op: 'cancel', appointmentId });
      return Promise.resolve(true);
    },
  } as unknown as import('../src/reminders/appointment-lifecycle.service').AppointmentLifecycleService;

  const handler = new AgentTurnHandler(
    models,
    conversationsRepo,
    {
      getById: () => Promise.resolve({ id: 'contact-1', phone: '+5511999998888', optOutAt: null }),
      setOptOut: () => {
        calls.optOuts += 1;
        return Promise.resolve();
      },
    } as unknown as ContactsRepository,
    {
      getCurrent: () =>
        Promise.resolve({
          id: 'clinic-1',
          name: 'Clínica Teste',
          timezone: 'America/Sao_Paulo',
          settings: { supervisedMode: opts.supervised ?? false },
        }),
    } as unknown as ClinicsRepository,
    { list: () => Promise.resolve([]) } as unknown as ServicesRepository,
    {} as AvailabilityService,
    {} as AppointmentsRepository,
    lifecycle,
    {
      send: (params: Record<string, unknown>) => {
        calls.sends.push(params);
        return Promise.resolve(`sent-${calls.sends.length}`);
      },
    } as unknown as OutboxService,
    {
      publish: (clinicId: string, event: Record<string, unknown>) => {
        calls.events.push({ clinicId, ...event });
        return Promise.resolve();
      },
    } as unknown as InboxEventsService,
  );

  return { handler, calls, models };
}

const turn = (text: string): TurnInput => ({
  clinicId: 'clinic-1',
  conversationId: 'convo-1',
  messages: [{ messageId: 'msg-1', text, kind: 'text', timestamp: Date.now() }],
});

const outboundRow = (status: string, text: string): MessageRow =>
  ({
    id: `m-${status}`,
    direction: 'outbound',
    status,
    body: { text },
    transcription: null,
  }) as MessageRow;

describe('supervised mode', () => {
  it('parks agent replies as drafts and notifies the inbox — nothing reaches the outbox', async () => {
    const { handler, calls } = makeHandler({ supervised: true });
    await handler.handleTurn(turn('quanto custa a limpeza?'));

    expect(calls.sends).toHaveLength(0);
    expect(calls.drafts).toHaveLength(1);
    expect(calls.drafts[0]).toMatchObject({
      conversationId: 'convo-1',
      intent: { kind: 'text', text: 'Custa R$ 180!' },
    });
    expect(calls.events).toContainEqual({
      clinicId: 'clinic-1',
      type: 'message',
      conversationId: 'convo-1',
      messageId: 'draft-1',
    });
  });

  it('deterministic opt-out bypasses supervision — the confirmation sends directly', async () => {
    const { handler, calls } = makeHandler({ supervised: true });
    await handler.handleTurn(turn('sair'));

    expect(calls.optOuts).toBe(1);
    expect(calls.drafts).toHaveLength(0);
    expect(calls.sends).toHaveLength(1);
    expect(calls.sends[0]).toMatchObject({ source: 'agent', intent: { kind: 'text' } });
  });

  it('unsupervised clinics keep the direct outbox path', async () => {
    const { handler, calls } = makeHandler({ supervised: false });
    await handler.handleTurn(turn('quanto custa?'));

    expect(calls.drafts).toHaveLength(0);
    expect(calls.sends).toHaveLength(1);
  });
});

describe('confirmation replies (Phase 4)', () => {
  const awaiting = {
    kind: 'awaiting_confirmation',
    appointmentId: 'appt-9',
    options: [
      { id: 'confirm', label: 'Confirmar' },
      { id: 'reschedule', label: 'Remarcar' },
      { id: 'cancel', label: 'Cancelar' },
    ],
  };

  it('"1" confirms the appointment, clears the flag, acks — no LLM call', async () => {
    const { handler, calls, models } = makeHandler({ flowContext: awaiting });
    await handler.handleTurn(turn('1'));

    expect(calls.lifecycle).toEqual([{ op: 'confirm', appointmentId: 'appt-9' }]);
    expect(calls.flowContexts).toContainEqual({ kind: 'none' });
    expect(calls.sends).toHaveLength(1);
    expect(models.faqHistories).toHaveLength(0); // agent never ran
  });

  it('"cancelar" cancels the appointment (reminders/backfill via lifecycle)', async () => {
    const { handler, calls } = makeHandler({ flowContext: awaiting });
    await handler.handleTurn(turn('cancelar'));

    expect(calls.lifecycle).toEqual([{ op: 'cancel', appointmentId: 'appt-9' }]);
    expect(calls.sends).toHaveLength(1);
  });

  it('"2"/remarcar frees the slot then invites a new time', async () => {
    const { handler, calls } = makeHandler({ flowContext: awaiting });
    await handler.handleTurn(turn('2'));

    expect(calls.lifecycle).toEqual([{ op: 'cancel', appointmentId: 'appt-9' }]);
    expect(calls.sends).toHaveLength(1);
  });

  it('an unrelated reply clears the flag and falls through to the agent', async () => {
    const { handler, calls, models } = makeHandler({ flowContext: awaiting });
    await handler.handleTurn(turn('na verdade quanto custa a limpeza?'));

    expect(calls.lifecycle).toHaveLength(0);
    expect(calls.flowContexts).toContainEqual({ kind: 'none' });
    expect(models.faqHistories).toHaveLength(1); // handed to the agent
    expect(calls.sends).toHaveLength(1);
  });
});

describe('history allowlist', () => {
  it('drafts and discarded replies are invisible to the model; sent ones are not', async () => {
    const { handler, models } = makeHandler({
      supervised: false,
      history: [
        outboundRow('sent', 'mensagem enviada'),
        outboundRow('draft', 'rascunho pendente'),
        outboundRow('discarded', 'rascunho descartado'),
        outboundRow('queued', 'ainda na fila'),
      ],
    });
    await handler.handleTurn(turn('oi'));

    const flat = models.faqHistories[0]!.map((m) => String(m.content)).join('\n');
    expect(flat).toContain('mensagem enviada');
    expect(flat).not.toContain('rascunho pendente');
    expect(flat).not.toContain('rascunho descartado');
    expect(flat).not.toContain('ainda na fila');
  });
});
