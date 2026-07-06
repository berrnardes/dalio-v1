// Campaigns module — DOCUMENTO-EXECUTIVO §3.4 (Phase 6): reactivation as
// service-recurrence nudges with recorded suppressions and a capped drip.
// Exports the attribution service so the agent turn (replies) and the
// appointment lifecycle (conversions) can close the R$ loop. Fleet-wide
// pieces live in CampaignsDataModule (imported by NumbersModule — the canary
// kill-switch) to keep the graph acyclic.
import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { MessagingDataModule } from '../conversations/messaging-data.module';
import { OutboundModule } from '../outbound/outbound.module';
import { SchedulingDataModule } from '../scheduling/scheduling-data.module';
import { CampaignAttributionService } from './campaign-attribution.service';
import { CampaignDispatchScheduler, CampaignDispatchWorker } from './campaign-dispatch.worker';
import { CampaignsController } from './campaigns.controller';
import { CampaignsDataModule } from './campaigns-data.module';
import { CampaignsRepository } from './campaigns.repository';
import { SegmentBuilder } from './segment.builder';

@Module({
  imports: [
    CampaignsDataModule,
    ChannelsModule,
    MessagingDataModule,
    OutboundModule,
    SchedulingDataModule,
  ],
  controllers: [CampaignsController],
  providers: [
    CampaignsRepository,
    SegmentBuilder,
    CampaignAttributionService,
    CampaignDispatchScheduler,
    CampaignDispatchWorker,
  ],
  exports: [CampaignAttributionService, CampaignsRepository],
})
export class CampaignsModule {}
