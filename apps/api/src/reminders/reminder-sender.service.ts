// Proactive send helper — SPEC §4 (Phase 4). Reminders and waitlist backfill
// both need to open (or reuse) the contact's conversation on the clinic's
// channel and drop an OutboundIntent into the outbox as source='reminder'.
// The canContact opt-out gate and per-channel pacing run downstream in the
// outbound worker (iron rules #4/#6) — this only enqueues.
import { Injectable } from '@nestjs/common';
import type { OutboundIntent } from '@dalio/shared';
import { ChannelsRepository } from '../channels/channels.repository';
import { ConversationsRepository } from '../conversations/conversations.repository';
import { OutboxService } from '../outbound/outbox.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

export interface ProactiveSendResult {
  messageId: string;
  conversationId: string;
  channelId: string;
}

@Injectable()
export class ReminderSenderService {
  constructor(
    private readonly conversationsRepo: ConversationsRepository,
    private readonly channelsRepo: ChannelsRepository,
    private readonly outbox: OutboxService,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * Sends a proactive intent to a contact. `channelId` may be passed (the
   * scanner already resolved one) or omitted (waitlist backfill) — when
   * omitted and the clinic has no connected channel, returns null: an
   * unreachable clinic is skipped, never a failed job.
   */
  async send(params: {
    contactId: string;
    intent: OutboundIntent;
    channelId?: string | null;
  }): Promise<ProactiveSendResult | null> {
    const channelId =
      params.channelId ??
      (await this.channelsRepo.findConnectedChannelId(this.tenant.requireClinicId()));
    if (!channelId) return null;

    const conversation = await this.conversationsRepo.findOrCreateOpen(params.contactId, channelId);
    const messageId = await this.outbox.send({
      conversationId: conversation.id,
      channelId,
      intent: params.intent,
      source: 'reminder',
    });
    return { messageId, conversationId: conversation.id, channelId };
  }
}
