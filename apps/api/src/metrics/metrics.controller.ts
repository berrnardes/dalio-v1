// Metrics endpoint — SPEC §7: `GET /metrics/summary?month=YYYY-MM`. Auth'd
// like every dashboard route (session + tenant guards from AppModule); the
// month defaults to the clinic's current wall-clock month so the dashboard's
// landing view is always "this month so far".
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type { MetricsSummary } from '@dalio/shared';
import { ClinicsRepository } from '../scheduling/clinics.repository';
import { MetricsService } from './metrics.service';
import { currentMonth, isValidMonth } from './month-window';

@Controller('api/v1/metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly clinicsRepo: ClinicsRepository,
  ) {}

  @Get('summary')
  async summary(@Query('month') month?: string): Promise<MetricsSummary> {
    if (month !== undefined && !isValidMonth(month)) {
      throw new BadRequestException('month must be YYYY-MM');
    }
    const resolved = month ?? currentMonth((await this.clinicsRepo.getCurrent()).timezone);
    return this.metrics.summary(resolved);
  }
}
