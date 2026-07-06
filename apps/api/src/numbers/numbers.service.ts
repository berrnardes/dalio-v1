// Number fleet operations — DOCUMENTO-EXECUTIVO §3.2/3.3 (Phase 6): the
// state machine enforcement, quality scoring, warm-up advancement, the ban
// runbook's pool swap, and the canary alarm. A ban here is an OPERATIONAL
// incident, not an existential one (company SIMs): data survives in the DB;
// this service's job is restoring reachability fast.
import { Injectable, Logger } from '@nestjs/common';
import type { NumberState } from '@dalio/shared';
import { CampaignsFleetRepository } from '../campaigns/campaigns-fleet.repository';
import {
  DEGRADED_SCORE_THRESHOLD,
  SCORE_DELTA,
  WARMUP_TARGET_QUOTA,
  applyScoreDelta,
  canTransition,
  warmupComplete,
  warmupQuotaForAge,
} from './number-policy';
import { NumbersRepository } from './numbers.repository';
import type { NumberRow } from './numbers.repository';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class NumbersService {
  private readonly logger = new Logger(NumbersService.name);

  constructor(
    private readonly numbersRepo: NumbersRepository,
    private readonly campaignsFleet: CampaignsFleetRepository,
  ) {}

  /** Guarded transition: illegal moves throw — a state machine that can be
   *  bypassed is a diagram, not a machine. */
  async transition(
    id: string,
    to: NumberState,
    extra: Parameters<NumbersRepository['transition']>[3] = {},
  ): Promise<NumberRow> {
    const current = await this.numbersRepo.getById(id);
    if (!current) throw new Error(`Number ${id} not found`);
    if (!canTransition(current.state, to)) {
      throw new Error(`Illegal number transition ${current.state} → ${to}`);
    }
    const row = await this.numbersRepo.transition(id, current.state, to, extra);
    if (!row) throw new Error(`Concurrent transition lost for number ${id}`);
    this.logger.log(`Number ${row.phone}: ${current.state} → ${to}`);
    return row;
  }

  /**
   * Warm-up tick (scheduler): every warming number's quota is recomputed from
   * its AGE — idempotent, so reruns/missed ticks converge — and numbers past
   * the ramp graduate to the standby pool at the full reactivation ceiling.
   */
  async warmupTick(now: Date = new Date()): Promise<void> {
    const warming = await this.numbersRepo.listByState('warming');
    for (const n of warming) {
      const startedAt = n.warmupStartedAt ?? now;
      const ageDays = (now.getTime() - startedAt.getTime()) / DAY_MS;
      if (warmupComplete(ageDays)) {
        await this.transition(n.id, 'standby', { dailyQuota: WARMUP_TARGET_QUOTA });
      } else {
        const quota = warmupQuotaForAge(ageDays);
        if (quota !== n.dailyQuota) await this.numbersRepo.setDailyQuota(n.id, quota);
      }
    }
  }

  /** Outbound worker hook: provider send failed on this channel. */
  async recordDeliveryFailure(channelId: string): Promise<void> {
    await this.adjustScore(channelId, SCORE_DELTA.deliveryFailure);
  }

  /** Outbound worker hook: provider send succeeded — slow trust recovery. */
  async recordDeliverySuccess(channelId: string): Promise<void> {
    await this.adjustScore(channelId, SCORE_DELTA.deliverySuccess);
  }

  /** Session-health hook: a FAILED session smells like enforcement. */
  async recordSessionFailure(channelId: string): Promise<void> {
    await this.adjustScore(channelId, SCORE_DELTA.sessionFailure);
  }

  /**
   * Ban runbook step 1+2 (detection is ops/session-health; this is the swap):
   * mark the number banned, promote the oldest pre-warmed standby to the
   * clinic, and point the clinic's channels at it (status 'provisioning' —
   * pairing the new SIM is our ops job). The /wa/<slug> redirect follows the
   * active number automatically, so published links heal on their own.
   * Returns null when the pool is empty — THE alert that must never fire.
   */
  async replaceBanned(numberId: string): Promise<{ banned: NumberRow; replacement: NumberRow } | null> {
    const banned = await this.transition(numberId, 'banned', { bannedAt: new Date() });
    await this.alarmIfCanary(banned);

    const clinicId = banned.clinicId;
    if (!clinicId) return { banned, replacement: banned }; // pool number banned pre-assignment

    const standby = await this.numbersRepo.findOldestUnassignedStandby();
    if (!standby) {
      this.logger.error(
        `NO STANDBY NUMBER AVAILABLE to replace ${banned.phone} (clinic ${clinicId}) — clinic is unreachable until a SIM is provisioned`,
      );
      return null;
    }

    const replacement = await this.transition(standby.id, 'active', {
      clinicId,
      activatedAt: new Date(),
    });
    await this.numbersRepo.transitionChannels(banned.id, replacement.id);
    // Banned row keeps clinicId for audit; the pointer records the succession.
    await this.numbersRepo.setReplacedBy(banned.id, replacement.id);

    // Step 3 — proactive resume protocol (runbook, human-executed): re-pair
    // the new SIM, then re-contact conversations that were in flight. The
    // inbox digest lists them; content never goes to logs (iron rule #7).
    this.logger.warn(
      `Ban swap done: ${banned.phone} → ${replacement.phone} (clinic ${clinicId}). ` +
        `Next: pair the new session, update nothing else (redirect follows the active number), ` +
        `and run the proactive resume protocol from the inbox digest.`,
    );
    return { banned, replacement };
  }

  private async adjustScore(channelId: string, delta: number): Promise<void> {
    const number = await this.numbersRepo.findByChannelId(channelId);
    if (!number) return; // channel not pool-managed (dev/pilot) — nothing to score
    const score = applyScoreDelta(number.qualityScore, delta);
    if (score !== number.qualityScore) await this.numbersRepo.setQualityScore(number.id, score);

    if (
      score < DEGRADED_SCORE_THRESHOLD &&
      delta < 0 &&
      (number.state === 'active' || number.state === 'warming' || number.state === 'standby')
    ) {
      const degraded = await this.numbersRepo.transition(number.id, number.state, 'degraded');
      if (degraded) {
        this.logger.error(
          `Number ${number.phone} degraded (score ${score}) — review for replacement (POST /api/v1/numbers/${number.id}/replace)`,
        );
        await this.alarmIfCanary(degraded);
      }
    }
  }

  /**
   * Canary tripwire (DOCUMENTO-EXECUTIVO §3.2): canaries mimic fleet behavior
   * precisely so THEY fall first in a detection wave. One going down pauses
   * every running campaign fleet-wide — reactivation volume is the riskiest
   * traffic we emit, and it must stop before the wave reaches revenue numbers.
   */
  private async alarmIfCanary(number: NumberRow): Promise<void> {
    if (!number.isCanary) return;
    const paused = await this.campaignsFleet.pauseAllRunning();
    this.logger.error(
      `CANARY DOWN (${number.phone}, state ${number.state}) — possible Meta detection wave. ` +
        `Paused ${paused} running campaign(s) fleet-wide. Hold all reactivation until reviewed.`,
    );
  }
}
