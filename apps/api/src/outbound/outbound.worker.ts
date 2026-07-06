// Outbound worker — SPEC §4.3 `outbound` queue: per-conversation FIFO,
// per-channel humanized pacing (anti-ban — DOCUMENTO-EXECUTIVO §3.3), the
// canContact gate, template rendering, and the actual provider send.
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type IORedis from 'ioredis';
import { QUEUES } from '@dalio/shared';
import type { OutboundIntent, OutboundJob, RatePolicy } from '@dalio/shared';
import { channels, numbers } from '../db/schema';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import type { ProviderRegistry } from '../channels/providers/messaging-provider';
import { PROVIDER_REGISTRY } from '../channels/providers/messaging-provider';
import { renderChoiceAsText } from '../channels/providers/choice-parsing';
import { ContactsRepository } from '../conversations/contacts.repository';
import { ConversationsRepository } from '../conversations/conversations.repository';
import { InboxEventsService } from '../inbox/inbox-events.service';
import { NumbersService } from '../numbers/numbers.service';
import { REDIS } from '../queues/queues.module';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { CanContactService } from './can-contact.service';
import { TemplateRenderService } from './template-render.service';

/**
 * Pacing defaults when channels.rate_policy is null. Policy is per-channel
 * data, not code (iron rule #6): warming numbers get tighter overrides in
 * their row. maxPerDay gates PROACTIVE sends only — replying to someone who
 * just wrote in is never what gets a number banned.
 */
const DEFAULT_RATE_POLICY: RatePolicy = {
  maxPerDay: 200,
  minJitterMs: 1_200,
  maxJitterMs: 4_000,
};

const PROACTIVE = new Set(['reminder', 'campaign']);

@Processor(QUEUES.OUTBOUND, { concurrency: 10 })
export class OutboundWorker extends WorkerHost {
  private readonly logger = new Logger(OutboundWorker.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: IORedis,
    @Inject(PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
    @InjectQueue(QUEUES.OUTBOUND) private readonly outboundQueue: Queue<OutboundJob>,
    private readonly conversationsRepo: ConversationsRepository,
    private readonly contactsRepo: ContactsRepository,
    private readonly canContact: CanContactService,
    private readonly templateRender: TemplateRenderService,
    private readonly inboxEvents: InboxEventsService,
    private readonly tenantContext: TenantContextService,
    private readonly numbers: NumbersService,
  ) {
    super();
  }

  async process(job: Job<OutboundJob>): Promise<void> {
    const { messageId, clinicId, conversationId, channelId } = job.data;

    await this.tenantContext.run({ clinicId, userId: 'system:outbound' }, async () => {
      const message = await this.conversationsRepo.getMessageById(messageId);
      if (!message || message.status !== 'queued') return; // already handled

      // FIFO per conversation: only the OLDEST queued message may leave.
      // uuidv7 ids are time-ordered, so this is one indexed lookup. A
      // younger message re-queues itself and checks again — order is
      // enforced by data, not by job scheduling luck.
      const firstQueued = await this.conversationsRepo.firstQueuedOutboundId(conversationId);
      if (firstQueued !== messageId) {
        await this.requeue(job.data, 500);
        return;
      }

      const conversation = await this.conversationsRepo.getById(conversationId);
      const contact = conversation && (await this.contactsRepo.getById(conversation.contactId));
      const channel = await this.getChannel(channelId);
      if (!conversation || !contact || !channel) {
        await this.conversationsRepo.markMessageFailed(messageId, 'missing conversation/contact/channel');
        await this.notify(clinicId, conversationId, messageId);
        return;
      }

      // Iron rule #4: the gate runs at SEND time — an opt-out that landed
      // after enqueue must still win.
      const decision = this.canContact.check(contact, message.source);
      if (!decision.allowed) {
        await this.conversationsRepo.markMessageFailed(messageId, decision.reason);
        await this.notify(clinicId, conversationId, messageId);
        return;
      }

      const policy = channel.ratePolicy ?? DEFAULT_RATE_POLICY;
      const proactive = PROACTIVE.has(message.source);

      // Humanized pacing: a per-channel gap key with jittered TTL. If the
      // gap is closed we re-queue for roughly when it opens — bursts of
      // instant sends are both robotic UX and a ban heuristic.
      const jitter =
        policy.minJitterMs +
        Math.floor(Math.random() * Math.max(1, policy.maxJitterMs - policy.minJitterMs));
      const gapAcquired = await this.redis.set(
        `rate:gap:{${channelId}}`,
        '1',
        'PX',
        jitter,
        'NX',
      );
      if (!gapAcquired) {
        const remaining = await this.redis.pttl(`rate:gap:{${channelId}}`);
        await this.requeue(job.data, Math.max(remaining, 100) + Math.floor(Math.random() * 400));
        return;
      }

      // Daily proactive cap (warm-up discipline). Conversational replies
      // bypass the cap but still pace through the gap above. Pool-managed
      // channels (Phase 6) are ALSO bounded by the number's own quota — a
      // warming SIM's ramp wins over whatever the channel policy says.
      if (proactive) {
        const maxPerDay = Math.min(policy.maxPerDay, channel.numberQuota ?? Infinity);
        const day = new Date().toISOString().slice(0, 10);
        const count = await this.redis.incr(`rate:day:{${channelId}}:${day}`);
        await this.redis.pexpire(`rate:day:{${channelId}}:${day}`, 25 * 60 * 60 * 1000);
        if (count > maxPerDay) {
          await this.conversationsRepo.markMessageFailed(messageId, 'daily_cap_exceeded');
          this.logger.warn(`Daily cap hit on channel ${channelId} — proactive send dropped`);
          await this.notify(clinicId, conversationId, messageId);
          return;
        }
      }

      const intent = message.intent;
      if (!intent) {
        await this.conversationsRepo.markMessageFailed(messageId, 'outbox row has no intent');
        await this.notify(clinicId, conversationId, messageId);
        return;
      }

      // Template intents resolve to text HERE (WahaProvider refuses them):
      // rendering needs the DB, adapters must not.
      const resolved: OutboundIntent =
        intent.kind === 'template'
          ? { kind: 'text', text: await this.templateRender.render(intent.templateKey, intent.variables) }
          : intent;

      const provider = this.providers.get(channel.provider);
      try {
        const result = await provider.send(
          { externalId: channel.externalId, host: channel.host },
          contact.phone,
          resolved,
        );
        const renderedText =
          resolved.kind === 'text'
            ? resolved.text
            : resolved.kind === 'choice'
              ? renderChoiceAsText(resolved)
              : null;
        await this.conversationsRepo.markMessageSent(
          messageId,
          result.providerMessageId,
          renderedText,
        );
        await this.conversationsRepo.touchLastOutbound(conversationId, new Date());
        await this.notify(clinicId, conversationId, messageId);
        // Quality scoring (Phase 6): deliveries feed the number's score.
        // Best-effort — scoring must never fail a send that already left.
        await this.numbers.recordDeliverySuccess(channelId).catch(() => undefined);
      } catch (err) {
        // Persist the failure detail, then rethrow so BullMQ retries with
        // backoff; the final failed attempt stays queryable in the DB.
        await this.conversationsRepo.markMessageFailed(messageId, err);
        await this.notify(clinicId, conversationId, messageId);
        await this.numbers.recordDeliveryFailure(channelId).catch(() => undefined);
        throw err;
      }
    });
  }

  /** Live inbox (Phase 3): every terminal status change (sent/failed) is
   *  observable in the dashboard without polling. Id-pointers only. */
  private notify(clinicId: string, conversationId: string, messageId: string): Promise<void> {
    return this.inboxEvents.publish(clinicId, { type: 'message', conversationId, messageId });
  }

  private async requeue(data: OutboundJob, delayMs: number): Promise<void> {
    await this.outboundQueue.add('send', data, {
      jobId: `out-${data.messageId}-r${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      delay: delayMs,
    });
  }

  private async getChannel(channelId: string) {
    const [row] = await this.db
      .select({
        id: channels.id,
        provider: channels.provider,
        externalId: channels.externalId,
        host: channels.host,
        ratePolicy: channels.ratePolicy,
        // Pool-managed channels carry the number's live quota (iron rule #6:
        // the ramp lives in numbers.daily_quota, written by the warm-up tick).
        numberQuota: numbers.dailyQuota,
      })
      .from(channels)
      .leftJoin(numbers, eq(numbers.id, channels.numberId))
      .where(eq(channels.id, channelId))
      .limit(1);
    return row ?? null;
  }
}
