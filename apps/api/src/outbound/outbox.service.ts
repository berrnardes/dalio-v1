// Outbox — SPEC §4.3: the message row exists in Postgres (status=queued)
// BEFORE any send is attempted, so a crash between "decided to send" and
// "sent" leaves an inspectable queued row instead of a silent gap. Jobs
// carry only ids (iron rule #7 — no content in Redis job payloads beyond
// the buffer, and none in logs).
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUES } from '@dalio/shared';
import type { MessageKind, OutboundIntent, OutboundJob } from '@dalio/shared';
import { ConversationsRepository } from '../conversations/conversations.repository';
import { InboxEventsService } from '../inbox/inbox-events.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

const intentToKind = (intent: OutboundIntent): MessageKind => {
  switch (intent.kind) {
    case 'text':
    case 'choice':
      return 'text';
    case 'template':
      return 'template';
    case 'media':
      return 'image';
  }
};

@Injectable()
export class OutboxService {
  constructor(
    private readonly conversationsRepo: ConversationsRepository,
    private readonly tenantContext: TenantContextService,
    private readonly inboxEvents: InboxEventsService,
    @InjectQueue(QUEUES.OUTBOUND) private readonly outboundQueue: Queue<OutboundJob>,
  ) {}

  /**
   * The ONLY way any feature sends a WhatsApp message (iron rule #2 —
   * everything is an OutboundIntent; adapters render). Returns the outbox
   * message id.
   */
  async send(params: {
    conversationId: string;
    channelId: string;
    intent: OutboundIntent;
    source: 'agent' | 'human' | 'reminder' | 'campaign' | 'system';
  }): Promise<string> {
    const message = await this.conversationsRepo.appendOutboundQueued({
      conversationId: params.conversationId,
      source: params.source,
      kind: intentToKind(params.intent),
      intent: params.intent,
    });

    await this.outboundQueue.add(
      'send',
      {
        messageId: message.id,
        clinicId: this.tenantContext.requireClinicId(),
        conversationId: params.conversationId,
        channelId: params.channelId,
      },
      { jobId: `out-${message.id}` },
    );

    // Live inbox (Phase 3): the queued row is already visible in the timeline.
    await this.inboxEvents.publish(this.tenantContext.requireClinicId(), {
      type: 'message',
      conversationId: params.conversationId,
      messageId: message.id,
    });
    return message.id;
  }

  /**
   * Hands an APPROVED supervised-mode draft to the outbound FIFO (Phase 3).
   * The caller (inbox) already flipped the row draft → queued with a guarded
   * update; this only enqueues the send job. The fixed `out-<id>` jobId is
   * safe here because a draft is enqueued at most once by that guard.
   */
  async enqueueApproved(params: {
    messageId: string;
    conversationId: string;
    channelId: string;
  }): Promise<void> {
    const clinicId = this.tenantContext.requireClinicId();
    await this.outboundQueue.add(
      'send',
      {
        messageId: params.messageId,
        clinicId,
        conversationId: params.conversationId,
        channelId: params.channelId,
      },
      { jobId: `out-${params.messageId}` },
    );
    await this.inboxEvents.publish(clinicId, {
      type: 'message',
      conversationId: params.conversationId,
      messageId: params.messageId,
    });
  }
}
