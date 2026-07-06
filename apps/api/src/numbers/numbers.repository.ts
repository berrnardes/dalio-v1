// Numbers pool persistence — DOCUMENTO-EXECUTIVO §3.2 (Phase 6). The THIRD
// deliberately non-tenant-scoped repository (after ChannelsRepository and
// RemindersScanRepository): the number fleet is COMPANY infrastructure — SIMs
// live in a shared pool before assignment (clinic_id null), and warm-up /
// canary / replacement operations are fleet-wide by nature. Everything else
// stays tenant-scoped (iron rule #1).
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { NumberState } from '@dalio/shared';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { channels, clinics, numbers } from '../db/schema';

export type NumberRow = typeof numbers.$inferSelect;

@Injectable()
export class NumbersRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getById(id: string): Promise<NumberRow | undefined> {
    const [row] = await this.db.select().from(numbers).where(eq(numbers.id, id)).limit(1);
    return row;
  }

  /** The number behind a channel, when the channel is pool-managed. */
  async findByChannelId(channelId: string): Promise<NumberRow | undefined> {
    const [row] = await this.db
      .select({ n: numbers })
      .from(channels)
      .innerJoin(numbers, eq(numbers.id, channels.numberId))
      .where(eq(channels.id, channelId))
      .limit(1);
    return row?.n;
  }

  async listByState(state: NumberState): Promise<NumberRow[]> {
    return this.db.select().from(numbers).where(eq(numbers.state, state));
  }

  /** The clinic's current active number — what the /wa/<slug> redirect points at. */
  async findActiveForClinic(clinicId: string): Promise<NumberRow | undefined> {
    const [row] = await this.db
      .select()
      .from(numbers)
      .where(and(eq(numbers.clinicId, clinicId), eq(numbers.state, 'active')))
      .limit(1);
    return row;
  }

  /**
   * Public redirect resolution (`GET /wa/<slug>`): clinic slug → its active
   * number's phone. Anonymous route, so this read is deliberately outside the
   * tenant scope — it returns ONLY the phone of an active clinic, nothing
   * else leaves.
   */
  async findActivePhoneByClinicSlug(slug: string): Promise<string | null> {
    const [row] = await this.db
      .select({ phone: numbers.phone })
      .from(numbers)
      .innerJoin(clinics, eq(clinics.id, numbers.clinicId))
      .where(
        and(eq(clinics.slug, slug), eq(clinics.status, 'active'), eq(numbers.state, 'active')),
      )
      .limit(1);
    return row?.phone ?? null;
  }

  /**
   * Oldest unassigned standby — the replacement pool. Oldest first: it has
   * the longest warm-up behind it, so it can absorb the reassigned clinic's
   * traffic with the least ban risk.
   */
  async findOldestUnassignedStandby(): Promise<NumberRow | undefined> {
    const [row] = await this.db
      .select()
      .from(numbers)
      .where(and(eq(numbers.state, 'standby'), isNull(numbers.clinicId)))
      .orderBy(asc(numbers.warmupStartedAt))
      .limit(1);
    return row;
  }

  /**
   * Guarded state write: the WHERE re-checks `from`, so a concurrent
   * transition loses cleanly (returns undefined) instead of teleporting the
   * state machine. Extra fields ride along (bannedAt, clinicId, quota...).
   */
  async transition(
    id: string,
    from: NumberState,
    to: NumberState,
    extra: Partial<typeof numbers.$inferInsert> = {},
  ): Promise<NumberRow | undefined> {
    const [row] = await this.db
      .update(numbers)
      .set({ state: to, ...extra })
      .where(and(eq(numbers.id, id), eq(numbers.state, from)))
      .returning();
    return row;
  }

  async setDailyQuota(id: string, dailyQuota: number): Promise<void> {
    await this.db.update(numbers).set({ dailyQuota }).where(eq(numbers.id, id));
  }

  async setQualityScore(id: string, qualityScore: number): Promise<void> {
    await this.db.update(numbers).set({ qualityScore }).where(eq(numbers.id, id));
  }

  /**
   * Ban-swap channel rewire: every channel riding the banned number starts
   * pointing at the replacement, back in 'provisioning' until ops pairs the
   * new SIM. Channels are infra tables like numbers — this fleet write lives
   * here (not ChannelsRepository) to keep ChannelsModule ← NumbersModule a
   * one-way street (module-cycle pattern, CLAUDE.md).
   */
  async transitionChannels(fromNumberId: string, toNumberId: string): Promise<void> {
    await this.db
      .update(channels)
      .set({ numberId: toNumberId, status: 'provisioning' })
      .where(eq(channels.numberId, fromNumberId));
  }

  /** Succession pointer: audits which number replaced the banned one. */
  async setReplacedBy(bannedId: string, replacementId: string): Promise<void> {
    await this.db
      .update(numbers)
      .set({ replacedById: replacementId })
      .where(eq(numbers.id, bannedId));
  }

  async create(values: typeof numbers.$inferInsert): Promise<NumberRow> {
    const [row] = await this.db.insert(numbers).values(values).returning();
    return row!;
  }

  async listAll(): Promise<NumberRow[]> {
    return this.db.select().from(numbers).orderBy(asc(numbers.state), asc(numbers.phone));
  }
}
