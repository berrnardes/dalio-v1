// Metrics math unit tests — SPEC §7 (Phase 5). The pure pieces that, if
// wrong, put a wrong R$ number in front of a clinic owner: clinic-local month
// boundaries, the out-of-hours lead classifier, and the first-response
// median. The SQL aggregations are covered by the integration spec.
import { describe, expect, it } from 'vitest';
import {
  currentMonth,
  isOutsideWorkingHours,
  isValidMonth,
  monthRangeUtc,
} from '../src/metrics/month-window';
import { firstResponseStats } from '../src/metrics/metrics.service';
import type { LeadConversation } from '../src/metrics/metrics.repository';

const TZ = 'America/Sao_Paulo';

describe('month window', () => {
  it('validates YYYY-MM strictly', () => {
    expect(isValidMonth('2026-07')).toBe(true);
    expect(isValidMonth('2026-13')).toBe(false);
    expect(isValidMonth('2026-7')).toBe(false);
    expect(isValidMonth('junho')).toBe(false);
  });

  it('computes clinic-local month boundaries as UTC instants', () => {
    // São Paulo is UTC-3: local July 1st 00:00 = 03:00Z.
    const { start, end } = monthRangeUtc('2026-07', TZ);
    expect(start.toISOString()).toBe('2026-07-01T03:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-01T03:00:00.000Z');
  });

  it('resolves the current month by clinic wall clock, not UTC', () => {
    // 01:00Z on Aug 1st is still 22:00 July 31st in São Paulo.
    expect(currentMonth(TZ, new Date('2026-08-01T01:00:00Z'))).toBe('2026-07');
    expect(currentMonth(TZ, new Date('2026-08-01T04:00:00Z'))).toBe('2026-08');
  });
});

describe('isOutsideWorkingHours', () => {
  // 2026-06-10 is a Wednesday (day 3).
  const settings = { workingHours: { 3: { open: '09:00', close: '19:00' } } };
  const wedAt = (hhmm: string) => new Date(`2026-06-10T${hhmm}:00-03:00`);

  it('inside configured hours is not an after-hours lead', () => {
    expect(isOutsideWorkingHours(settings, TZ, wedAt('14:00'))).toBe(false);
  });

  it('before open / after close is after-hours', () => {
    expect(isOutsideWorkingHours(settings, TZ, wedAt('08:59'))).toBe(true);
    expect(isOutsideWorkingHours(settings, TZ, wedAt('22:00'))).toBe(true);
  });

  it('a day with no configured hours is entirely after-hours (closed)', () => {
    // 2026-06-14 is a Sunday — not in workingHours above.
    expect(isOutsideWorkingHours(settings, TZ, new Date('2026-06-14T11:00:00-03:00'))).toBe(true);
    expect(isOutsideWorkingHours(null, TZ, wedAt('14:00'))).toBe(true);
  });
});

describe('firstResponseStats', () => {
  const lead = (latencySec: number | null): LeadConversation => {
    const firstInboundAt = new Date('2026-06-10T14:00:00Z');
    return {
      conversationId: 'c',
      contactId: 'k',
      firstInboundAt,
      firstReplyAt:
        latencySec === null ? null : new Date(firstInboundAt.getTime() + latencySec * 1000),
    };
  };

  it('reports nulls when no lead was answered yet', () => {
    expect(firstResponseStats([])).toEqual({
      medianSeconds: null,
      underSixtySecondsPct: null,
      conversationsMeasured: 0,
    });
    expect(firstResponseStats([lead(null)]).medianSeconds).toBeNull();
  });

  it('computes the median for odd and even counts', () => {
    expect(firstResponseStats([lead(10), lead(30), lead(500)]).medianSeconds).toBe(30);
    expect(firstResponseStats([lead(30), lead(90)]).medianSeconds).toBe(60);
  });

  it('excludes unanswered leads from the math but not silently: measured count is answered-only', () => {
    const stats = firstResponseStats([lead(30), lead(null), lead(45)]);
    expect(stats.conversationsMeasured).toBe(2);
    expect(stats.underSixtySecondsPct).toBe(100);
  });

  it('under-60s share counts strictly-under (the <1min promise)', () => {
    const stats = firstResponseStats([lead(59), lead(60), lead(61), lead(10)]);
    expect(stats.underSixtySecondsPct).toBe(50);
  });
});
