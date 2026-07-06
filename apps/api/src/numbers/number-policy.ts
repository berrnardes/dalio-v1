// Number lifecycle policy — DOCUMENTO-EXECUTIVO §3.2/3.3 (Phase 6). The pure
// rules of the anti-ban subsystem: which state transitions exist, how the
// warm-up ramp grows a fresh SIM's quota, and how the quality score moves.
// Pure functions so every rule is unit-testable; the LIVE quota always lives
// in numbers.daily_quota (iron rule #6 — policy is data, this file only
// computes what to write there).
import type { NumberState } from '@dalio/shared';

/**
 * The lifecycle state machine. Everything can be retired (SIM decommissioned);
 * bans are terminal except for retirement — a banned number never returns to
 * traffic, its REPLACEMENT does (replacedById).
 */
export const NUMBER_TRANSITIONS: Record<NumberState, readonly NumberState[]> = {
  provisioning: ['warming', 'retired'],
  warming: ['standby', 'degraded', 'banned', 'retired'],
  standby: ['active', 'degraded', 'banned', 'retired'],
  active: ['degraded', 'banned', 'retired'],
  degraded: ['active', 'banned', 'retired'], // recovered after ops review
  banned: ['retired'],
  retired: [],
};

export function canTransition(from: NumberState, to: NumberState): boolean {
  return NUMBER_TRANSITIONS[from].includes(to);
}

/**
 * Warm-up ramp (DOCUMENTO-EXECUTIVO §3.3: "~10 msgs/dia ao longo de 2–4
 * semanas"): start at 10/day, +2/day, capped at the reactivation ceiling of
 * 50/day. After WARMUP_DAYS the number is pool-ready (→ standby). Quota is a
 * function of AGE, not of tick count — reruns and missed ticks converge.
 */
export const WARMUP_START_QUOTA = 10;
export const WARMUP_DAILY_INCREMENT = 2;
export const WARMUP_TARGET_QUOTA = 50;
export const WARMUP_DAYS = 21;

export function warmupQuotaForAge(ageDays: number): number {
  const clamped = Math.max(0, Math.floor(ageDays));
  return Math.min(WARMUP_START_QUOTA + clamped * WARMUP_DAILY_INCREMENT, WARMUP_TARGET_QUOTA);
}

export function warmupComplete(ageDays: number): boolean {
  return ageDays >= WARMUP_DAYS;
}

/**
 * Quality score movement (1.0 = pristine). Delivery failures are the leading
 * indicator DOCUMENTO-EXECUTIVO names for degradation; session failures are
 * heavier (a dropped session smells like enforcement, not like a bad phone
 * number). Successes recover slowly — trust is rebuilt at a crawl.
 */
export const SCORE_DELTA = {
  deliveryFailure: -0.05,
  sessionFailure: -0.2,
  deliverySuccess: +0.01,
} as const;

/** Below this the number is auto-marked degraded and ops gets paged. */
export const DEGRADED_SCORE_THRESHOLD = 0.5;

export function applyScoreDelta(score: number, delta: number): number {
  return Math.min(1, Math.max(0, Math.round((score + delta) * 100) / 100));
}
