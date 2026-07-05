// Waitlist persistence — SPEC §4 (Phase 4): when a slot frees (cancel/no-show)
// a waiting contact can backfill it, recovering revenue the empty chair would
// have lost. Tenant-scoped (iron rule #1).
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { waitlist } from '../db/schema';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';

export type WaitlistRow = typeof waitlist.$inferSelect;

@Injectable()
export class WaitlistRepository extends TenantScopedRepository {
  async add(params: {
    contactId: string;
    serviceId: string;
    windowStart?: Date | null;
    windowEnd?: Date | null;
  }): Promise<WaitlistRow> {
    const [row] = await this.db
      .insert(waitlist)
      .values({
        clinicId: this.clinicId,
        contactId: params.contactId,
        serviceId: params.serviceId,
        windowStart: params.windowStart ?? null,
        windowEnd: params.windowEnd ?? null,
      })
      .returning();
    return row!;
  }

  /**
   * The oldest un-notified, unfulfilled waiter for a service whose desired
   * window (if any) contains the freed slot. Notifying ONE per freed slot
   * avoids a stampede racing for a single chair — the notified contact
   * rebooks through the agent, and the next freed slot picks the next waiter.
   */
  async findMatchingForSlot(serviceId: string, slotStart: Date): Promise<WaitlistRow | null> {
    const [row] = await this.db
      .select()
      .from(waitlist)
      .where(
        and(
          eq(waitlist.clinicId, this.clinicId),
          eq(waitlist.serviceId, serviceId),
          isNull(waitlist.notifiedAt),
          isNull(waitlist.fulfilledAppointmentId),
          or(isNull(waitlist.windowStart), lte(waitlist.windowStart, slotStart)),
          or(isNull(waitlist.windowEnd), gte(waitlist.windowEnd, slotStart)),
        ),
      )
      .orderBy(asc(waitlist.id))
      .limit(1);
    return row ?? null;
  }

  async markNotified(id: string): Promise<void> {
    await this.db
      .update(waitlist)
      .set({ notifiedAt: new Date() })
      .where(and(eq(waitlist.clinicId, this.clinicId), eq(waitlist.id, id)));
  }
}
