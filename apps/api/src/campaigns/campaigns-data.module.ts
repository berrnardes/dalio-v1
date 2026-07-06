// Campaigns data module — Phase 6. Holds only the fleet repository so
// NumbersModule (canary alarm) can pause campaigns without importing the full
// CampaignsModule — which imports OutboundModule, which imports NumbersModule
// (per-number caps + delivery scoring). Same cycle-breaking pattern as
// MessagingDataModule / SchedulingDataModule (CLAUDE.md).
import { Module } from '@nestjs/common';
import { CampaignsFleetRepository } from './campaigns-fleet.repository';

@Module({
  providers: [CampaignsFleetRepository],
  exports: [CampaignsFleetRepository],
})
export class CampaignsDataModule {}
