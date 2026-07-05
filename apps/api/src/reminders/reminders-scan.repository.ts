// Due-reminder scan — SPEC §4 (Phase 4). The SECOND deliberately
// non-tenant-scoped repository (see ChannelsRepository): the 1/min scanner
// runs across ALL clinics, so this query cannot be tenant-scoped — it IS what
// tells the scanner which clinic each due reminder belongs to. Every write
// the scanner then performs happens inside that clinic's tenant scope.
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import type { ClinicSettings, ReminderKind } from '@dalio/shared';
import { appointments, channels, clinics, contacts, reminders, services } from '../db/schema';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';

/** One due reminder with everything needed to render and send it. */
export interface DueReminder {
  reminderId: string;
  kind: ReminderKind;
  dueAt: Date;
  appointmentId: string;
  appointmentStatus: string;
  startsAt: Date;
  clinicId: string;
  clinicTimezone: string;
  clinicSettings: ClinicSettings | null;
  contactId: string;
  contactName: string | null;
  contactOptedOut: boolean;
  serviceName: string;
  /** A CONNECTED channel for the clinic, or null → scanner can't send. */
  channelId: string | null;
}

@Injectable()
export class RemindersScanRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Due reminders (dueAt ≤ now, unsent, uncancelled) across all clinics,
   * oldest first. DISTINCT ON (reminder) collapses the row if a clinic has
   * more than one connected channel — one send, not N. Suspended clinics are
   * excluded: a suspended clinic must go silent immediately.
   */
  findDue(now: Date, limit = 200): Promise<DueReminder[]> {
    return this.db
      .selectDistinctOn([reminders.id], {
        reminderId: reminders.id,
        kind: reminders.kind,
        dueAt: reminders.dueAt,
        appointmentId: appointments.id,
        appointmentStatus: appointments.status,
        startsAt: appointments.startsAt,
        clinicId: clinics.id,
        clinicTimezone: clinics.timezone,
        clinicSettings: clinics.settings,
        contactId: contacts.id,
        contactName: contacts.name,
        contactOptOutAt: contacts.optOutAt,
        serviceName: services.name,
        channelId: channels.id,
      })
      .from(reminders)
      .innerJoin(appointments, eq(appointments.id, reminders.appointmentId))
      .innerJoin(clinics, and(eq(clinics.id, reminders.clinicId), eq(clinics.status, 'active')))
      .innerJoin(contacts, eq(contacts.id, appointments.contactId))
      .innerJoin(services, eq(services.id, appointments.serviceId))
      .leftJoin(
        channels,
        and(eq(channels.clinicId, reminders.clinicId), eq(channels.status, 'connected')),
      )
      .where(and(isNull(reminders.sentAt), isNull(reminders.cancelledAt), lte(reminders.dueAt, now)))
      .orderBy(asc(reminders.id))
      .limit(limit)
      .then((rows) =>
        rows.map((r) => ({
          reminderId: r.reminderId,
          kind: r.kind,
          dueAt: r.dueAt,
          appointmentId: r.appointmentId,
          appointmentStatus: r.appointmentStatus,
          startsAt: r.startsAt,
          clinicId: r.clinicId,
          clinicTimezone: r.clinicTimezone,
          clinicSettings: r.clinicSettings,
          contactId: r.contactId,
          contactName: r.contactName,
          contactOptedOut: r.contactOptOutAt !== null,
          serviceName: r.serviceName,
          channelId: r.channelId,
        })),
      );
  }
}
