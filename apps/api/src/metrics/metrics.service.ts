// Hero-metrics assembly — SPEC §7 / DOCUMENTO-EXECUTIVO §1: "a proposta de
// valor é mensurável em reais". This service turns the repository's raw
// aggregates into the MetricsSummary the dashboard renders — including the
// one deliberate estimate (recovered no-shows × baseline rate), which is the
// renewal argument and must stay labeled as an estimate, never as billing.
import { Injectable } from '@nestjs/common';
import type { MetricsSummary } from '@dalio/shared';
import { DEFAULT_NO_SHOW_RATE_PCT } from '@dalio/shared';
import { ClinicsRepository } from '../scheduling/clinics.repository';
import { MetricsRepository } from './metrics.repository';
import type { LeadConversation } from './metrics.repository';
import { isOutsideWorkingHours, monthRangeUtc } from './month-window';

@Injectable()
export class MetricsService {
  constructor(
    private readonly metricsRepo: MetricsRepository,
    private readonly clinicsRepo: ClinicsRepository,
  ) {}

  /** Builds the month's MetricsSummary for the current tenant. */
  async summary(month: string): Promise<MetricsSummary> {
    const clinic = await this.clinicsRepo.getCurrent();
    const range = monthRangeUtc(month, clinic.timezone);

    const [bookings, confirmed, leads] = await Promise.all([
      this.metricsRepo.agentBookings(range),
      this.metricsRepo.confirmedAfterReminder(range),
      this.metricsRepo.leadConversations(range),
    ]);

    // Recovered no-shows: of the chairs the cadence got confirmed, the
    // clinic's baseline rate says how many would statistically have gone
    // empty. Rounded down — the dashboard should undersell, not oversell.
    const noShowRatePct = clinic.settings?.noShowRatePct ?? DEFAULT_NO_SHOW_RATE_PCT;
    const estimatedCents = Math.floor((confirmed.cents * noShowRatePct) / 100);

    // Out-of-hours classification runs on the lead's FIRST inbound: that is
    // the moment a human-only clinic would have missed it.
    const afterHours = leads.filter((l) =>
      isOutsideWorkingHours(clinic.settings, clinic.timezone, l.firstInboundAt),
    );
    const converted = await this.metricsRepo.agentBookingsForContacts(
      range,
      [...new Set(afterHours.map((l) => l.contactId))],
    );

    return {
      month,
      autonomousBookings: bookings,
      recoveredNoShows: { count: confirmed.count, estimatedCents, noShowRatePct },
      firstResponse: firstResponseStats(leads),
      afterHoursLeads: { count: afterHours.length, convertedCount: converted.count, cents: converted.cents },
    };
  }
}

/**
 * Median + <60s share of first-response latency. Only answered leads enter
 * the math (an unanswered lead has no latency yet), but the measured count is
 * reported so the UI can show the denominator honestly. Exported for unit
 * tests — this is pure arithmetic.
 */
export function firstResponseStats(leads: LeadConversation[]): MetricsSummary['firstResponse'] {
  const latencies = leads
    .filter((l) => l.firstReplyAt !== null)
    .map((l) => (l.firstReplyAt!.getTime() - l.firstInboundAt.getTime()) / 1000)
    .sort((a, b) => a - b);

  if (latencies.length === 0) {
    return { medianSeconds: null, underSixtySecondsPct: null, conversationsMeasured: 0 };
  }

  const mid = latencies.length / 2;
  const median =
    latencies.length % 2 === 1 ? latencies[mid - 0.5]! : (latencies[mid - 1]! + latencies[mid]!) / 2;
  const under60 = latencies.filter((s) => s < 60).length;

  return {
    medianSeconds: Math.round(median),
    underSixtySecondsPct: Math.round((under60 / latencies.length) * 100),
    conversationsMeasured: latencies.length,
  };
}
