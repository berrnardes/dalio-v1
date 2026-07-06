// The agent turn — Phase 2's binding for the TURN_HANDLER seam. The pipeline
// (Phase 1) guarantees this runs coalesced and serialized per conversation;
// this handler decides WHAT a turn does: guard checks, deterministic opt-out,
// history assembly from the messages table, one LangGraph run, and replies
// out through the outbox (iron rule #2 — only OutboundIntents leave).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { OutboundIntent } from '@dalio/shared';
import { CampaignAttributionService } from '../campaigns/campaign-attribution.service';
import { ContactsRepository } from '../conversations/contacts.repository';
import { ConversationsRepository } from '../conversations/conversations.repository';
import type { MessageRow } from '../conversations/conversations.repository';
import { InboxEventsService } from '../inbox/inbox-events.service';
import type { TurnHandler, TurnInput } from '../conversations/turn-handler';
import { ServicesRepository } from '../catalog/services.repository';
import { OutboxService } from '../outbound/outbox.service';
import { AppointmentLifecycleService } from '../reminders/appointment-lifecycle.service';
import { ConfirmationBuilder } from '../reminders/confirmation.builder';
import { AppointmentsRepository } from '../scheduling/appointments.repository';
import { AvailabilityService } from '../scheduling/availability.service';
import { ClinicsRepository } from '../scheduling/clinics.repository';
import { CONFIRMATION_OPTIONS } from '@dalio/shared';
import type { AgentModels } from './agent-models';
import { AGENT_MODELS } from './agent-models';
import { runAgentGraph } from './agent-graph';
import { CONFIRMATION_REPLIES, OPT_OUT_REPLY, buildSystemPrompt, isOpenNow } from './agent-prompts';
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
    private readonly lifecycle: AppointmentLifecycleService,
    private readonly outbox: OutboxService,
    private readonly inboxEvents: InboxEventsService,
    private readonly campaignAttribution: CampaignAttributionService,
  ) {}

  async handleTurn(input: TurnInput): Promise<void> {
    const conversation = await this.conversationsRepo.getById(input.conversationId);
    if (!conversation) return;

    // Human takeover: while paused, the dashboard inbox owns this thread —
    // the agent answering over the team is instant-churn territory.
    if (conversation.pausedUntil && conversation.pausedUntil > new Date()) return;

    const contact = await this.contactsRepo.getById(conversation.contactId);
    if (!contact) return;

    // Campaign attribution (Phase 6): any inbound from a recently-messaged
    // recipient counts as the reply — cheap no-op otherwise, and the flag
    // clears so the agent treats the thread as a normal conversation.
    await this.campaignAttribution.recordReply(contact.id);
    if (conversation.flowContext?.kind === 'awaiting_campaign_reply') {
      await this.conversationsRepo.setFlowContext(conversation.id, { kind: 'none' });
    }

    const burstText = input.messages.map((m) => m.text).join('\n');

    // Deterministic opt-out BEFORE any LLM call: LGPD enforcement must not
    // depend on model behavior (iron rule #4). Runs even when the LLM is
    // unconfigured — compliance can't hinge on an API key being present.
    if (detectOptOut(burstText)) {
      await this.contactsRepo.setOptOut(contact.id);
      await this.sendAgentText(conversation, OPT_OUT_REPLY);
      return;
    }

    // Confirmation reply (Phase 4): if a reminder set the conversation to
    // awaiting_confirmation, map the reply to an action DETERMINISTICALLY —
    // never the LLM (a wrong "confirmed" costs the clinic a chair). Also runs
    // regardless of LLM config: the no-show engine must work without a key. A
    // reply that isn't a clear choice clears the flag and falls through to the
    // agent (the contact changed the subject).
    if (conversation.flowContext?.kind === 'awaiting_confirmation') {
      const handled = await this.handleConfirmationReply(conversation, burstText);
      if (handled) return;
      await this.conversationsRepo.setFlowContext(conversation.id, { kind: 'none' });
    }

    // Everything below needs the LLM. Dev/test without a key observes silently
    // (the deterministic flows above already ran).
    if (!this.models.configured) {
      this.logger.warn(`Agent unconfigured — skipping LLM turn for ${input.conversationId}`);
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
          lifecycle: this.lifecycle,
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
      if (clinic.settings?.supervisedMode) {
        // Supervised mode (Phase 3 — pilot trust ramp): the reply parks as a
        // draft for the inbox to approve; nothing reaches WhatsApp until a
        // human clicks. Deterministic opt-out above already sent directly —
        // LGPD compliance never waits in an approval queue.
        await this.saveDraft(input.clinicId, conversation.id, reply);
      } else {
        await this.outbox.send({
          conversationId: conversation.id,
          channelId: conversation.channelId,
          intent: reply,
          source: 'agent',
        });
      }
    }
  }

  /**
   * Maps a confirmation reply to an appointment action. Returns false when the
   * reply isn't a clear choice (caller then hands the turn to the agent).
   * The action (confirm/cancel) runs through the lifecycle so reminders and
   * waitlist backfill fire; the ack is a deterministic reactive reply that
   * sends directly (the state change already happened — it must be told).
   */
  private async handleConfirmationReply(
    conversation: { id: string; channelId: string; flowContext: unknown },
    burstText: string,
  ): Promise<boolean> {
    const flow = conversation.flowContext as {
      kind: 'awaiting_confirmation';
      appointmentId: string;
      options: { id: string; label: string }[];
    };
    const optionId = ConfirmationBuilder.parseReply(burstText, flow.options);
    if (!optionId) return false;

    switch (optionId) {
      case CONFIRMATION_OPTIONS.CONFIRM:
        await this.lifecycle.confirm(flow.appointmentId);
        await this.clearFlowAndReply(conversation, CONFIRMATION_REPLIES.confirmed);
        return true;
      case CONFIRMATION_OPTIONS.CANCEL:
        await this.lifecycle.cancel(flow.appointmentId);
        await this.clearFlowAndReply(conversation, CONFIRMATION_REPLIES.cancelled);
        return true;
      case CONFIRMATION_OPTIONS.RESCHEDULE:
        // Free the slot now (cancels reminders + backfills); the agent rebooks
        // when the contact names a new time in their next message.
        await this.lifecycle.cancel(flow.appointmentId);
        await this.clearFlowAndReply(conversation, CONFIRMATION_REPLIES.reschedule);
        return true;
      default:
        return false;
    }
  }

  private async clearFlowAndReply(
    conversation: { id: string; channelId: string },
    text: string,
  ): Promise<void> {
    await this.conversationsRepo.setFlowContext(conversation.id, { kind: 'none' });
    await this.sendAgentText(conversation, text);
  }

  private async sendAgentText(
    conversation: { id: string; channelId: string },
    text: string,
  ): Promise<void> {
    await this.outbox.send({
      conversationId: conversation.id,
      channelId: conversation.channelId,
      intent: { kind: 'text', text },
      source: 'agent',
    });
  }

  private async saveDraft(
    clinicId: string,
    conversationId: string,
    intent: OutboundIntent,
  ): Promise<void> {
    const draft = await this.conversationsRepo.appendOutboundDraft({
      conversationId,
      kind: intent.kind === 'media' ? 'image' : intent.kind === 'template' ? 'template' : 'text',
      intent,
    });
    // Drafts demand a human: surface them in the live inbox immediately.
    await this.inboxEvents.publish(clinicId, {
      type: 'message',
      conversationId,
      messageId: draft.id,
    });
  }
}

/** Statuses whose text actually reached (or will reach) the contact. An
 *  ALLOWLIST on purpose: a blocklist silently leaked new statuses — drafts
 *  and discarded replies must never appear as things the agent "said". */
const DELIVERED_STATUSES = new Set(['sent', 'delivered', 'read']);

/** messages rows → LangChain history. Inbound uses the transcription when the
 *  original was audio; outbound rows that never sent are invisible history. */
function toLangChainHistory(rows: MessageRow[]): BaseMessage[] {
  const result: BaseMessage[] = [];
  for (const row of rows) {
    if (row.direction === 'inbound') {
      const text = row.transcription ?? row.body.text ?? row.body.caption ?? '[mídia recebida]';
      result.push(new HumanMessage(text));
    } else if (DELIVERED_STATUSES.has(row.status) && row.body.text) {
      result.push(new AIMessage(row.body.text));
    }
  }
  return result;
}
