// The agent turn — Phase 2's binding for the TURN_HANDLER seam. The pipeline
// (Phase 1) guarantees this runs coalesced and serialized per conversation;
// this handler decides WHAT a turn does: guard checks, deterministic opt-out,
// history assembly from the messages table, one LangGraph run, and replies
// out through the outbox (iron rule #2 — only OutboundIntents leave).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { ContactsRepository } from '../conversations/contacts.repository';
import { ConversationsRepository } from '../conversations/conversations.repository';
import type { MessageRow } from '../conversations/conversations.repository';
import type { TurnHandler, TurnInput } from '../conversations/turn-handler';
import { ServicesRepository } from '../catalog/services.repository';
import { OutboxService } from '../outbound/outbox.service';
import { AppointmentsRepository } from '../scheduling/appointments.repository';
import { AvailabilityService } from '../scheduling/availability.service';
import { ClinicsRepository } from '../scheduling/clinics.repository';
import type { AgentModels } from './agent-models';
import { AGENT_MODELS } from './agent-models';
import { runAgentGraph } from './agent-graph';
import { OPT_OUT_REPLY, buildSystemPrompt, isOpenNow } from './agent-prompts';
import { buildAgentTools } from './agent-tools';
import { detectOptOut } from './opt-out.detector';

/** Handoff pause: the agent stays silent while the team owns the thread.
 *  Long enough for a human shift, short enough to self-heal if nobody acts. */
const HANDOFF_PAUSE_MS = 8 * 60 * 60 * 1000;

@Injectable()
export class AgentTurnHandler implements TurnHandler {
  private readonly logger = new Logger(AgentTurnHandler.name);

  constructor(
    @Inject(AGENT_MODELS) private readonly models: AgentModels,
    private readonly conversationsRepo: ConversationsRepository,
    private readonly contactsRepo: ContactsRepository,
    private readonly clinicsRepo: ClinicsRepository,
    private readonly servicesRepo: ServicesRepository,
    private readonly availability: AvailabilityService,
    private readonly appointmentsRepo: AppointmentsRepository,
    private readonly outbox: OutboxService,
  ) {}

  async handleTurn(input: TurnInput): Promise<void> {
    // Dev environments without an API key observe silently instead of
    // failing the job into BullMQ retries.
    if (!this.models.configured) {
      this.logger.warn(`Agent unconfigured — skipping turn for ${input.conversationId}`);
      return;
    }

    const conversation = await this.conversationsRepo.getById(input.conversationId);
    if (!conversation) return;

    // Human takeover: while paused, the dashboard inbox owns this thread —
    // the agent answering over the team is instant-churn territory.
    if (conversation.pausedUntil && conversation.pausedUntil > new Date()) return;

    const contact = await this.contactsRepo.getById(conversation.contactId);
    if (!contact) return;

    const burstText = input.messages.map((m) => m.text).join('\n');

    // Deterministic opt-out BEFORE any LLM call: LGPD enforcement must not
    // depend on model behavior (iron rule #4).
    if (detectOptOut(burstText)) {
      await this.contactsRepo.setOptOut(contact.id);
      await this.outbox.send({
        conversationId: conversation.id,
        channelId: conversation.channelId,
        intent: { kind: 'text', text: OPT_OUT_REPLY },
        source: 'agent',
      });
      return;
    }

    const clinic = await this.clinicsRepo.getCurrent();
    const services = await this.servicesRepo.list();
    const history = toLangChainHistory(
      await this.conversationsRepo.listRecentMessages(
        conversation.id,
        input.messages.map((m) => m.messageId),
      ),
    );

    const result = await runAgentGraph(
      {
        models: this.models,
        tools: buildAgentTools({
          availability: this.availability,
          appointmentsRepo: this.appointmentsRepo,
          contactId: contact.id,
          timezone: clinic.timezone,
        }),
        systemPrompt: buildSystemPrompt(clinic, services),
        isOpen: isOpenNow(clinic),
        onHandoff: async (reason) => {
          this.logger.log(`Handoff (${reason}) for conversation ${conversation.id}`);
          await this.conversationsRepo.pause(
            conversation.id,
            new Date(Date.now() + HANDOFF_PAUSE_MS),
            'agent:handoff',
          );
        },
        onOptOut: () => this.contactsRepo.setOptOut(contact.id),
      },
      history,
      burstText,
      {
        // LangSmith attribution (SPEC §8): per-tenant filtering via clinic_id.
        runName: 'agent-turn',
        metadata: { clinic_id: input.clinicId, conversation_id: conversation.id },
      },
    );

    // Sequential sends: the outbound worker enforces per-conversation FIFO,
    // but enqueueing in order keeps uuidv7 ids (the FIFO cursor) monotonic.
    for (const reply of result.replies) {
      await this.outbox.send({
        conversationId: conversation.id,
        channelId: conversation.channelId,
        intent: reply,
        source: 'agent',
      });
    }
  }
}

/** messages rows → LangChain history. Inbound uses the transcription when the
 *  original was audio; outbound rows that never sent are invisible history. */
function toLangChainHistory(rows: MessageRow[]): BaseMessage[] {
  const result: BaseMessage[] = [];
  for (const row of rows) {
    if (row.direction === 'inbound') {
      const text = row.transcription ?? row.body.text ?? row.body.caption ?? '[mídia recebida]';
      result.push(new HumanMessage(text));
    } else if (row.status !== 'queued' && row.status !== 'failed' && row.body.text) {
      result.push(new AIMessage(row.body.text));
    }
  }
  return result;
}
