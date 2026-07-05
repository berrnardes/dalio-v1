// Metrics module — SPEC §7 (Phase 5): the R$ dashboard backend, the product's
// renewal argument (DOCUMENTO-EXECUTIVO: "métricas em R$ desde o dia um").
// Read-only over the domain tables; depends on SchedulingDataModule only for
// the clinic row (timezone + settings drive month boundaries and estimates).
import { Module } from '@nestjs/common';
import { SchedulingDataModule } from '../scheduling/scheduling-data.module';
import { MetricsController } from './metrics.controller';
import { MetricsRepository } from './metrics.repository';
import { MetricsService } from './metrics.service';

@Module({
  imports: [SchedulingDataModule],
  controllers: [MetricsController],
  providers: [MetricsRepository, MetricsService],
})
export class MetricsModule {}
