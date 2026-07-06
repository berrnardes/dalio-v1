// Campaign dispatcher — DOCUMENTO-EXECUTIVO §3.4 (Phase 6). The 1/min tick
// walks every running campaign (scan-pattern, like the reminder scanner: the
// DB is the schedule) and sends AT MOST ONE recipient per campaign per tick,
// and only when the drip interval has elapsed — the cap-spread that makes
// reactivation the slow, humanized trickle it must be. Reactivation is the
// single riskiest traffic this product emits (§3.3): every guard here is a
// ban guard first and a UX guard second.
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUES } from '@dalio/shared';
import { ChannelsRepository } from '../channels/channels.repository';
import { ConversationsRepository } from '../conversations/conversations.repository';
import { OutboxService } from '../outbound/outbox.service';
import { ClinicsRepository } from '../scheduling/clinics.repository';
import { isWithinSendWindow } from '../reminders/send-window';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { CampaignsFleetRepository } from './campaigns-fleet.repository';
import type { CampaignRow } from './campaigns-fleet.repository';
import { CampaignsRepository } from './campaigns.repository';
import { SegmentBuilder } from './segment.builder';
import { dripIntervalMinutes, startOfLocalDay } from './drip-policy';

const SCAN_INTERVAL_MS = 60_000;
const SCHEDULER_KEY = 'campaign-dispatch-tick';

@Injectable()
export class CampaignDispatchScheduler implements OnModuleInit {
  private readonly logger = new Logger(CampaignDispatchScheduler.name);

  constructor(@InjectQueue(QUEUES.CAMPAIGN_DISPATCH) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SCHEDULER_KEY,
      { every: SCAN_INTERVAL_MS },
      { name: 'tick', opts: { removeOnComplete: true, removeOnFail: { count: 20 } } },
    );
    this.logger.log(`Campaign dispatcher scheduled every ${SCAN_INTERVAL_MS / 1000}s`);
  }
}

@Processor(QUEUES.CAMPAIGN_DISPATCH)
export class CampaignDispatchWorker extends WorkerHost {
  private readonly logger = new Logger(CampaignDispatchWorker.name);

  constructor(
    private readonly fleet: CampaignsFleetRepository,
    private readonly campaignsRepo: CampaignsRepository,
    private readonly segments: SegmentBuilder,
    private readonly clinicsRepo: ClinicsRepository,
    private readonly channelsRepo: ChannelsRepository,
    private readonly conversationsRepo: ConversationsRepository,
    private readonly outbox: OutboxService,
    private readonly tenant: TenantContextService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const running = await this.fleet.listRunning();
    for (const campaign of running) {
      // Per-clinic tenant scope; one campaign's failure never starves the rest.
      await this.tenant
        .run({ clinicId: campaign.clinicId, userId: 'system:campaigns' }, () =>
          this.tick(campaign),
        )
        .catch((err) =>
          this.logger.error(`Campaign ${campaign.id} tick failed: ${String(err)}`),
        );
    }
  }

  private async tick(campaign: CampaignRow): Promise<void> {
    const clinic = await this.clinicsRepo.getCurrent();

    // Guard 1 — send window: reactivation at 3am is the perfect ban signal.
    if (!isWithinSendWindow(clinic.settings, clinic.timezone)) return;

    // Guard 2 — daily cap, counted from clinic-local midnight.
    const sentToday = await this.campaignsRepo.countSentSince(
      campaign.id,
      startOfLocalDay(clinic.timezone),
    );
    if (sentToday >= campaign.dailyCap) return;

    // Guard 3 — drip interval: spread the cap across the window.
    const last = await this.campaignsRepo.lastSentAt(campaign.id);
    const intervalMs = dripIntervalMinutes(clinic.settings, campaign.dailyCap) * 60_000;
    if (last && Date.now() - last.getTime() < intervalMs) return;

    const recipient = await this.campaignsRepo.nextPending(campaign.id);
    if (!recipient) {
      // Snapshot exhausted — the campaign is done (guarded flip: a concurrent
      // pause wins over completion).
      await this.campaignsRepo.setStatus(campaign.id, 'running', 'done');
      this.logger.log(`Campaign ${campaign.id} exhausted its segment — done`);
      return;
    }

    // Guard 4 — late re-suppression: the snapshot may be days old; someone
    // who booked/replied/opted out since must drop out NOW. (Opt-out is also
    // re-checked by canContact at send — this records the reason instead of
    // failing the message.)
    const fresh = await this.segments.classifyContact(recipient.contactId);
    if (fresh) {
      await this.campaignsRepo.markSuppressed(recipient.id, fresh);
      return; // next tick moves to the next recipient
    }

    const channelId = await this.channelsRepo.findConnectedChannelId(clinic.id);
    if (!channelId) return; // unreachable clinic — resume when a session connects

    const conversation = await this.conversationsRepo.findOrCreateOpen(
      recipient.contactId,
      channelId,
    );
    await this.outbox.send({
      conversationId: conversation.id,
      channelId,
      // Template + variants = copy variation per send (anti-ban, iron rule #2).
      intent: {
        kind: 'template',
        templateKey: campaign.templateKey,
        variables: await this.variablesFor(recipient.contactId, recipient.serviceId),
      },
      source: 'campaign',
    });
    // The reply lands on the same agent; the flag lets attribution and the
    // router know a campaign is what started this thread.
    await this.conversationsRepo.setFlowContext(conversation.id, {
      kind: 'awaiting_campaign_reply',
      campaignId: campaign.id,
    });
    await this.campaignsRepo.markSent(recipient.id);
  }

  private async variablesFor(
    contactId: string,
    serviceId: string | null,
  ): Promise<Record<string, string>> {
    const member = await this.segments.describe(contactId, serviceId);
    return { nome: member.contactName ?? 'tudo bem', servico: member.serviceName ?? '' };
  }
}
