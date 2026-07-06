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
    return this.metrics.summary(await this.resolveMonth(month));
  }

  /** Pilot scorecard (Phase 7): goals vs actuals — the design-partner agenda. */
  @Get('pilot')
  async pilot(@Query('month') month?: string) {
    return this.metrics.pilotStatus(await this.resolveMonth(month));
  }

  private async resolveMonth(month?: string): Promise<string> {
    if (month !== undefined && !isValidMonth(month)) {
      throw new BadRequestException('month must be YYYY-MM');
    }
    return month ?? currentMonth((await this.clinicsRepo.getCurrent()).timezone);
  }
}
