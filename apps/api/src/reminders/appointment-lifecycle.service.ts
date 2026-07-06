// Appointment state machine — SPEC §4 (Phase 4, anti-no-show). The single
// entry point for every appointment WRITE, because each transition has side
// effects that must not be forgotten:
//
//   book      → scheduled + generate the reminder cadence
//   confirm   → confirmed (reminder reply / dashboard)
//   cancel    → cancelled + cancel pending reminders + waitlist backfill
//   no_show   → no_show   + cancel pending reminders + follow-up + backfill
//   completed → completed + cancel any leftover pre-appointment reminders
//   reschedule = cancel(old) then book(new): both side-effect chains run for
//                free, so "reminders regenerated on reschedule" is automatic.
//
// The agent tools and the dashboard controller both go through here — a raw
// appointmentsRepo.cancel() elsewhere would silently skip reminders/backfill.
import { Injectable } from '@nestjs/common';
import { addMinutes } from 'date-fns';
import { CampaignAttributionService } from '../campaigns/campaign-attribution.service';
import { ServicesRepository } from '../catalog/services.repository';
import { AppointmentsRepository } from '../scheduling/appointments.repository';
import { AvailabilityService } from '../scheduling/availability.service';
import { ClinicsRepository } from '../scheduling/clinics.repository';
import { RemindersRepository } from './reminders.repository';
import { WaitlistService } from './waitlist.service';

/** How long after a no-show to send the win-back nudge (T+ this). */
const NO_SHOW_FOLLOWUP_DELAY_MIN = 60;

type BookResult =
  | { ok: true; appointmentId: string; endsAt: Date }
  | { ok: false; reason: string };

@Injectable()
export class AppointmentLifecycleService {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly appointmentsRepo: AppointmentsRepository,
    private readonly clinicsRepo: ClinicsRepository,
    private readonly servicesRepo: ServicesRepository,
    private readonly remindersRepo: RemindersRepository,
    private readonly waitlist: WaitlistService,
    private readonly campaignAttribution: CampaignAttributionService,
  ) {}

  /**
   * Books a slot and, on success, generates the reminder cadence from the
   * clinic's offsets. Reminder generation is best-effort relative to the
   * booking: the appointment is the source of truth; a cadence gap is
   * recoverable, a lost booking is not — but generation failing would throw,
   * so it stays inside the same call for now (single DB, same request).
   */
  async book(params: {
    contactId: string;
    serviceId: string;
    startsAtISO: string;
    source: 'agent' | 'human';
  }): Promise<BookResult> {
    const result = await this.availability.book(params);
    if (!result.ok) return result;

    const clinic = await this.clinicsRepo.getCurrent();
    const startsAt = new Date(params.startsAtISO);
    await this.remindersRepo.generateForAppointment({
      appointmentId: result.appointmentId,
      startsAt,
      offsets: clinic.settings?.reminderOffsets,
    });
    // Campaign conversion (Phase 6): booking through the single write path is
    // what lets attribution be complete — best-effort, never fails the booking.
    await this.campaignAttribution.recordConversion(params.contactId, result.appointmentId);
    return result;
  }

  async confirm(appointmentId: string): Promise<boolean> {
    const row = await this.appointmentsRepo.confirm(appointmentId);
    return row !== undefined;
  }

  /**
   * Cancels an appointment and runs its side effects exactly once (the repo's
   * status guard makes cancel idempotent — a double call won't double-notify
   * the waitlist).
   */
  async cancel(appointmentId: string): Promise<boolean> {
    const freed = await this.appointmentsRepo.cancel(appointmentId);
    if (!freed) return false;
    await this.remindersRepo.cancelForAppointment(appointmentId);
    await this.backfill(freed.serviceId, freed.startsAt);
    return true;
  }

  async markNoShow(appointmentId: string): Promise<boolean> {
    const row = await this.appointmentsRepo.transitionTo(appointmentId, 'no_show');
    if (!row) return false;
    // Pending pre-appointment reminders are moot; replace them with the
    // win-back follow-up. The freed slot can still backfill (someone else
    // may take that recurring time going forward).
    await this.remindersRepo.cancelForAppointment(appointmentId);
    await this.remindersRepo.generateNoShowFollowup(
      appointmentId,
      addMinutes(new Date(), NO_SHOW_FOLLOWUP_DELAY_MIN),
    );
    await this.backfill(row.serviceId, row.startsAt);
    return true;
  }

  async markCompleted(appointmentId: string): Promise<boolean> {
    const row = await this.appointmentsRepo.transitionTo(appointmentId, 'completed');
    if (!row) return false;
    await this.remindersRepo.cancelForAppointment(appointmentId);
    return true;
  }

  private async backfill(serviceId: string, slotStart: Date): Promise<void> {
    const clinic = await this.clinicsRepo.getCurrent();
    const service = await this.servicesRepo.getById(serviceId);
    await this.waitlist.onSlotFreed({
      serviceId,
      serviceName: service?.name ?? 'seu procedimento',
      slotStart,
      timezone: clinic.timezone,
    });
  }
}
