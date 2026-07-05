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
    return message.id;
  }
}
