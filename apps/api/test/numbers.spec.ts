// Numbers policy unit tests — DOCUMENTO-EXECUTIVO §3.2/3.3 (Phase 6). The
// pure anti-ban rules: a wrong transition puts a banned number back in
// traffic; a wrong ramp burns a fresh SIM; a wrong drip interval turns a
// campaign into a blast.
import { describe, expect, it } from 'vitest';
import {
  DEGRADED_SCORE_THRESHOLD,
  WARMUP_DAYS,
  WARMUP_START_QUOTA,
  WARMUP_TARGET_QUOTA,
  applyScoreDelta,
  canTransition,
  warmupComplete,
  warmupQuotaForAge,
} from '../src/numbers/number-policy';
import { dripIntervalMinutes, startOfLocalDay } from '../src/campaigns/drip-policy';

describe('number state machine', () => {
  it('allows the documented lifecycle path', () => {
    expect(canTransition('provisioning', 'warming')).toBe(true);
    expect(canTransition('warming', 'standby')).toBe(true);
    expect(canTransition('standby', 'active')).toBe(true);
    expect(canTransition('active', 'banned')).toBe(true);
    expect(canTransition('banned', 'retired')).toBe(true);
    expect(canTransition('degraded', 'active')).toBe(true); // ops recovery
  });

  it('a banned number never returns to traffic', () => {
    expect(canTransition('banned', 'active')).toBe(false);
    expect(canTransition('banned', 'standby')).toBe(false);
    expect(canTransition('banned', 'warming')).toBe(false);
  });

  it('no state resurrects from retired, no ramp skipping', () => {
    expect(canTransition('retired', 'active')).toBe(false);
    expect(canTransition('provisioning', 'active')).toBe(false); // must warm first
    expect(canTransition('provisioning', 'standby')).toBe(false);
  });
});

describe('warm-up ramp', () => {
  it('starts at 10/day and grows toward the 50/day reactivation ceiling', () => {
    expect(warmupQuotaForAge(0)).toBe(WARMUP_START_QUOTA);
    expect(warmupQuotaForAge(5)).toBe(20);
    expect(warmupQuotaForAge(100)).toBe(WARMUP_TARGET_QUOTA); // capped
  });

  it('is a function of age — fractional days floor, negatives clamp', () => {
    expect(warmupQuotaForAge(2.9)).toBe(warmupQuotaForAge(2));
    expect(warmupQuotaForAge(-3)).toBe(WARMUP_START_QUOTA);
  });

  it('graduates to the standby pool after the ramp', () => {
    expect(warmupComplete(WARMUP_DAYS - 1)).toBe(false);
    expect(warmupComplete(WARMUP_DAYS)).toBe(true);
  });
});

describe('quality score', () => {
  it('clamps to [0, 1] and rounds to cents of score', () => {
    expect(applyScoreDelta(1.0, +0.01)).toBe(1.0);
    expect(applyScoreDelta(0.1, -0.2)).toBe(0);
    expect(applyScoreDelta(1.0, -0.05)).toBe(0.95);
  });

  it('three session failures from pristine cross the degraded threshold', () => {
    let score = 1.0;
    for (let i = 0; i < 2; i++) score = applyScoreDelta(score, -0.2);
    expect(score).toBeGreaterThanOrEqual(DEGRADED_SCORE_THRESHOLD); // 0.6 — still ok
    score = applyScoreDelta(score, -0.2);
    expect(score).toBeLessThan(DEGRADED_SCORE_THRESHOLD); // 0.4 — degraded
  });
});

describe('campaign drip pacing', () => {
  it('spreads the daily cap across the send window', () => {
    // 08:00–20:00 = 720min / cap 50 → one send every 14min.
    expect(dripIntervalMinutes({ sendWindow: { start: '08:00', end: '20:00' } }, 50)).toBe(14);
    expect(dripIntervalMinutes(null, 20)).toBe(36); // default window
  });

  it('never drips faster than the 2min floor', () => {
    expect(dripIntervalMinutes({ sendWindow: { start: '08:00', end: '09:00' } }, 50)).toBe(2);
  });

  it('computes the clinic-local day start as a UTC instant', () => {
    // 01:00Z is 22:00 the PREVIOUS day in São Paulo — "today" started 03:00Z yesterday.
    const start = startOfLocalDay('America/Sao_Paulo', new Date('2026-07-10T01:00:00Z'));
    expect(start.toISOString()).toBe('2026-07-09T03:00:00.000Z');
  });
});
