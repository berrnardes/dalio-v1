// Metrics dashboard contract — SPEC §7, DOCUMENTO-EXECUTIVO §1 ("a proposta
// de valor é mensurável em reais"). The four hero metrics the dashboard shows
// as the renewal argument: each pairs a count with a cents figure so the UI
// can lead with R$ and support with volume. Computed on-read from the domain
// tables (appointments/reminders/messages/conversations) — no counters that
// can drift from the source of truth.

/** Default baseline no-show rate (%) when clinics.settings.noShowRatePct is unset. */
export const DEFAULT_NO_SHOW_RATE_PCT = 20;

/** One month of hero metrics for a clinic. All money in integer cents (BRL). */
export interface MetricsSummary {
  /** The month measured, 'YYYY-MM' in the clinic's timezone. */
  month: string;

  /**
   * Appointments the agent booked autonomously (source='agent') in the month.
   * `cents` is the real sum of the booked services' prices — revenue the
   * clinic captured without a human touching the conversation.
   */
  autonomousBookings: { count: number; cents: number };

  /**
   * Appointments confirmed after a confirmation reminder was sent (the
   * anti-no-show cadence doing its job). `estimatedCents` = sum of those
   * services' prices × noShowRatePct — the statistically-saved chairs. An
   * ESTIMATE by construction; the UI must label it as such.
   */
  recoveredNoShows: { count: number; estimatedCents: number; noShowRatePct: number };

  /**
   * First-response latency over conversations that started in the month:
   * first delivered outbound minus first inbound. The <5min lead-loss window
   * is the business threshold; the agent's promise is <60s.
   */
  firstResponse: { medianSeconds: number | null; underSixtySecondsPct: number | null; conversationsMeasured: number };

  /**
   * Conversations whose FIRST inbound arrived outside workingHours — leads a
   * human-only clinic would have lost to the morning. `convertedCount`/`cents`
   * are the agent bookings those same contacts made in the month.
   */
  afterHoursLeads: { count: number; convertedCount: number; cents: number };
}
