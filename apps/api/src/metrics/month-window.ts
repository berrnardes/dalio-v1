// Clinic-local month math — SPEC §7 (Phase 5 metrics). The dashboard measures
// calendar months as the clinic experiences them: "julho" starts at midnight
// in America/Sao_Paulo, not at midnight UTC (a 21h UTC-3 lead on the 31st
// belongs to THIS month). All helpers are pure so the R$ math is unit-testable
// without a database.
import { TZDate } from '@date-fns/tz';
import type { ClinicSettings } from '@dalio/shared';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Validates the dashboard's ?month= param ('YYYY-MM'). */
export function isValidMonth(month: string): boolean {
  return MONTH_RE.test(month);
}

/** The current month ('YYYY-MM') as the clinic's wall clock sees it. */
export function currentMonth(timezone: string, now: Date = new Date()): string {
  const local = new TZDate(now, timezone);
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * UTC instants of the clinic-local month boundaries: [start, end). Feed these
 * straight into timestamptz comparisons — Postgres stores UTC, so converting
 * once here keeps every metrics query timezone-correct without SQL tz math.
 */
export function monthRangeUtc(month: string, timezone: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return {
    start: new Date(new TZDate(y, m - 1, 1, 0, 0, 0, timezone).getTime()),
    end: new Date(new TZDate(y, m, 1, 0, 0, 0, timezone).getTime()),
  };
}

/**
 * True when `at` falls outside the clinic's workingHours (clinic-local).
 * A day with no configured hours is entirely "outside" — the clinic is closed
 * on Sundays, so a Sunday lead is exactly the kind a human-only clinic loses.
 * This is the classifier behind the "leads fora do horário" hero metric.
 */
export function isOutsideWorkingHours(
  settings: ClinicSettings | null,
  timezone: string,
  at: Date,
): boolean {
  const local = new TZDate(at, timezone);
  const hours = settings?.workingHours?.[local.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6];
  if (!hours) return true;
  const hhmm = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
  return hhmm < hours.open || hhmm >= hours.close;
}
