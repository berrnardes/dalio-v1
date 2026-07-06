// Numbers module — DOCUMENTO-EXECUTIVO §3.2/3.3 (Phase 6): the anti-ban
// subsystem as a first-class citizen. Owns the SIM fleet (state machine,
// warm-up ramp, quality scores, canary tripwire, ban-swap runbook) and the
// public /wa/<slug> redirect. Imports CampaignsDataModule (not
// CampaignsModule) so the canary alarm can pause campaigns fleet-wide
// without a module cycle (CampaignsModule → OutboundModule → NumbersModule).
import { Module } from '@nestjs/common';
import { CampaignsDataModule } from '../campaigns/campaigns-data.module';
import { NumbersController } from './numbers.controller';
import { NumbersRepository } from './numbers.repository';
import { NumbersService } from './numbers.service';
import { WaRedirectController } from './wa-redirect.controller';
import { WarmupScheduler, WarmupWorker } from './warmup.scheduler';

@Module({
  imports: [CampaignsDataModule],
  controllers: [NumbersController, WaRedirectController],
  providers: [NumbersRepository, NumbersService, WarmupScheduler, WarmupWorker],
  exports: [NumbersRepository, NumbersService],
})
export class NumbersModule {}
