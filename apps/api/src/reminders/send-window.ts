// Send window — SPEC §4 / DOCUMENTO-EXECUTIVO §3.3: proactive messages only
// inside the clinic's local business hours. "Nothing at 3am" is both basic
// courtesy and a ban-signal guard (odd-hours bursts read as automation).
import { TZDate } from '@date-fns/tz';
import type { ClinicSettings } from '@dalio/shared';

/** Fallback window when a clinic hasn't set settings.sendWindow. */
export const DEFAULT_SEND_WINDOW = { start: '08:00', end: '20:00' } as const;

/**
 * True when `now` (evaluated in the clinic's timezone) is inside the send
 * window. A reminder due outside the window is DEFERRED, not dropped: the
 * scanner leaves it unsent and the next in-window tick delivers it — a T-24h
 * confirmation whose dueAt lands at 2am simply goes out at window open.
 */
export function isWithinSendWindow(
  settings: ClinicSettings | null,
  timezone: string,
  now: Date = new Date(),
): boolean {
  const window = settings?.sendWindow ?? DEFAULT_SEND_WINDOW;
  const local = new TZDate(now, timezone);
  const hhmm = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
  return hhmm >= window.start && hhmm < window.end;
}
