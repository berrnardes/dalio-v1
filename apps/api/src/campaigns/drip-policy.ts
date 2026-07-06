// Drip pacing — DOCUMENTO-EXECUTIVO §3.3/3.4 (Phase 6): "campanha de 400
// clientes sai em duas semanas, não numa tarde". The daily cap is spread
// across the clinic's send window so reactivation looks like a human working
// through a list, not a cannon firing at 08:00. Pure math, unit-tested.
import { TZDate } from '@date-fns/tz';
import type { ClinicSettings } from '@dalio/shared';
import { DEFAULT_SEND_WINDOW } from '../reminders/send-window';

/**
 * Minutes between campaign sends: window length / daily cap, floored at 2min
 * (below that the per-channel jitter gap already dominates). A 12h window at
 * cap 50 → one send every ~14min.
 */
export function dripIntervalMinutes(settings: ClinicSettings | null, dailyCap: number): number {
  const window = settings?.sendWindow ?? DEFAULT_SEND_WINDOW;
  const minutes = hhmmToMinutes(window.end) - hhmmToMinutes(window.start);
  return Math.max(2, Math.floor(minutes / Math.max(1, dailyCap)));
}

/** UTC instant of the clinic-local midnight containing `now` — the "today"
 *  boundary for the daily-cap count. */
export function startOfLocalDay(timezone: string, now: Date = new Date()): Date {
  const local = new TZDate(now, timezone);
  return new Date(
    new TZDate(local.getFullYear(), local.getMonth(), local.getDate(), 0, 0, 0, timezone).getTime(),
  );
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}
