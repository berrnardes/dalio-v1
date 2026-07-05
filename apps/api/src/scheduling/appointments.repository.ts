// Appointments — SPEC §3, the revenue ledger of the whole product. Status
// machine: scheduled → confirmed → completed | no_show | cancelled |
// rescheduled (Phase 4 wires the reminder cadence to it).
import { Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lt, lte } from 'drizzle-orm';
import { appointments, services } from '../db/schema';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';

export type AppointmentRow = typeof appointments.$inferSelect;

/** Statuses that occupy a chair — what availability counts as "busy". */
const OCCUPYING = ['scheduled', 'confirmed'] as const;

@Injectable()
export class AppointmentsRepository extends TenantScopedRepository {
  async create(params: {
    contactId: string;
    serviceId: string;
    professionalId?: string | null;
    startsAt: Date;
    endsAt: Date;
    source: 'agent' | 'human' | 'reactivation';
  }): Promise<AppointmentRow> {
    const [row] = await this.db
      .insert(appointments)
      .values({ ...params, clinicId: this.clinicId, status: 'scheduled' })
      .returning();
    return row!;
  }

  /** Occupying appointments intersecting [from, to) — the availability input. */
  listOccupying(from: Date, to: Date): Promise<AppointmentRow[]> {
    return this.db
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.clinicId, this.clinicId),
          inArray(appointments.status, [...OCCUPYING]),
          lt(appointments.startsAt, to),
          gte(appointments.endsAt, from),
        ),
      );
  }

  listByRange(from: Date, to: Date): Promise<AppointmentRow[]> {
    return this.db
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.clinicId, this.clinicId),
          gte(appointments.startsAt, from),
          lte(appointments.startsAt, to),
        ),
      );
  }

  /** Upcoming occupying appointments for one contact, with service names —
   *  what the agent reads back to "quais são meus horários?". */
  listUpcomingByContact(contactId: string) {
    return this.db
      .select({
        id: appointments.id,
        startsAt: appointments.startsAt,
        endsAt: appointments.endsAt,
        status: appointments.status,
        serviceName: services.name,
      })
      .from(appointments)
      .innerJoin(services, eq(services.id, appointments.serviceId))
      .where(
        and(
          eq(appointments.clinicId, this.clinicId),
          eq(appointments.contactId, contactId),
          inArray(appointments.status, [...OCCUPYING]),
          gte(appointments.startsAt, new Date()),
        ),
      )
      .orderBy(appointments.startsAt);
  }

  async cancel(id: string): Promise<boolean> {
    const [row] = await this.db
      .update(appointments)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(appointments.clinicId, this.clinicId),
          eq(appointments.id, id),
          inArray(appointments.status, [...OCCUPYING]),
        ),
      )
      .returning({ id: appointments.id });
    return row !== undefined;
  }
}
