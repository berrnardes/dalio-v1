// Reminder cadence persistence — SPEC §4 (Phase 4, anti-no-show). Rows are
// generated when an appointment is booked and cancelled when it moves out of
// an occupying state; the scanner reads the DUE, unsent, uncancelled set.
// Tenant-scoped (iron rule #1) — the scanner opens the scope per clinic.
import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { ReminderKind } from '@dalio/shared';
import { reminders } from '../db/schema';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';

export type ReminderRow = typeof reminders.$inferSelect;

/**
 * Offset in minutes BEFORE startsAt for each pre-appointment reminder kind.
 * Defaults; a clinic overrides via settings.reminderOffsets. Not global
 * constants for policy — these are only the fallback when a clinic hasn't
 * tuned its cadence.
 */
export const DEFAULT_REMINDER_OFFSETS: Record<
  'confirm_24h' | 'reminder_3h' | 'at_risk_2h',
  number
> = {
  confirm_24h: 24 * 60,
  reminder_3h: 3 * 60,
  at_risk_2h: 2 * 60,
};

@Injectable()
export class RemindersRepository extends TenantScopedRepository {
  /**
   * Generates the pre-appointment cadence for a freshly booked appointment.
   * Only reminders whose dueAt is still in the future are created — booking
   * something 90 minutes out must not birth an already-overdue T-24h row the
   * scanner would fire immediately.
   */
  async generateForAppointment(params: {
    appointmentId: string;
    startsAt: Date;
    offsets?: { confirm24h?: number; reminder3h?: number; atRisk2h?: number };
    now?: Date;
  }): Promise<ReminderRow[]> {
    const now = params.now ?? new Date();
    const offsets = {
      confirm_24h: params.offsets?.confirm24h ?? DEFAULT_REMINDER_OFFSETS.confirm_24h,
      reminder_3h: params.offsets?.reminder3h ?? DEFAULT_REMINDER_OFFSETS.reminder_3h,
      at_risk_2h: params.offsets?.atRisk2h ?? DEFAULT_REMINDER_OFFSETS.at_risk_2h,
    };

    const rows = (Object.entries(offsets) as Array<[ReminderKind, number]>)
      .map(([kind, offsetMin]) => ({
        clinicId: this.clinicId,
        appointmentId: params.appointmentId,
        kind,
        dueAt: new Date(params.startsAt.getTime() - offsetMin * 60_000),
      }))
      .filter((r) => r.dueAt > now);

    if (rows.length === 0) return [];
    return this.db.insert(reminders).values(rows).returning();
  }

  /** Post-no-show win-back nudge (SPEC §4). dueAt defaults to soon-after. */
  async generateNoShowFollowup(
    appointmentId: string,
    dueAt: Date,
  ): Promise<ReminderRow> {
    const [row] = await this.db
      .insert(reminders)
      .values({ clinicId: this.clinicId, appointmentId, kind: 'no_show_followup', dueAt })
      .returning();
    return row!;
  }

  /**
   * Cancels every unsent reminder for an appointment (cancel/reschedule/
   * no-show all invalidate the pending cadence). Sent ones are left as the
   * historical record.
   */
  async cancelForAppointment(appointmentId: string): Promise<void> {
    await this.db
      .update(reminders)
      .set({ cancelledAt: new Date() })
      .where(
        and(
          eq(reminders.clinicId, this.clinicId),
          eq(reminders.appointmentId, appointmentId),
          isNull(reminders.sentAt),
          isNull(reminders.cancelledAt),
        ),
      );
  }

  /** Marks a reminder sent and links the outbox message (audit trail). */
  async markSent(reminderId: string, messageId: string): Promise<void> {
    await this.db
      .update(reminders)
      .set({ sentAt: new Date(), messageId })
      .where(and(eq(reminders.clinicId, this.clinicId), eq(reminders.id, reminderId)));
  }

  /** Cancels a single reminder (e.g. a confirmation nudge for an appointment
   *  that got confirmed by another kind first) without sending it. */
  async cancelById(reminderId: string): Promise<void> {
    await this.db
      .update(reminders)
      .set({ cancelledAt: new Date() })
      .where(and(eq(reminders.clinicId, this.clinicId), eq(reminders.id, reminderId)));
  }
}
