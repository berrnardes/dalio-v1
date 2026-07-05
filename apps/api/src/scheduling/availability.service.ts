// Availability engine — SPEC §7 GET /availability and the agent's
// get_available_slots tool. "The node where the money is"
// (DOCUMENTO-EXECUTIVO §3.4): if the agent can't offer REAL slots, it's
// conversational theater and the clinic is back to manual work.
//
// Model: the clinic has N parallel chairs (active professionals, min 1).
// A slot of `service.durationMin` starting at time T is free when fewer than
// N occupying appointments overlap [T, T+duration). All wall-clock math runs
// in the clinic's IANA timezone (TZDate) — appointments store timestamptz.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TZDate } from '@date-fns/tz';
import { addMinutes } from 'date-fns';
import { and, eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { services } from '../db/schema';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';
import { AppointmentsRepository } from './appointments.repository';
import { ClinicsRepository } from './clinics.repository';
import { ProfessionalsRepository } from './professionals.repository';

/** Slot grid granularity. Per-clinic override can come later if a real
 *  clinic asks; a finer default just multiplies noise in the agent's offer. */
const SLOT_STEP_MIN = 30;
/** Don't offer slots starting sooner than this — the clinic needs prep time
 *  and the contact needs travel time. */
const MIN_LEAD_MINUTES = 60;

export interface AvailableSlot {
  /** ISO 8601 with the clinic's offset — safe to hand to the LLM and back. */
  startsAt: string;
  endsAt: string;
}

@Injectable()
export class AvailabilityService extends TenantScopedRepository {
  // Explicit constructor (no rest-param forwarding): rest parameters emit no
  // decorator metadata and the base's @Inject(DB) metadata leaks through the
  // prototype chain — Nest resolves the wrong tokens. Found by the storm
  // suite's full-app boot; unit tests construct manually and can't see it.
  constructor(
    @Inject(DB) db: Db,
    tenant: TenantContextService,
    private readonly clinicsRepo: ClinicsRepository,
    private readonly professionalsRepo: ProfessionalsRepository,
    private readonly appointmentsRepo: AppointmentsRepository,
  ) {
    super(db, tenant);
  }

  /**
   * Free slots for a service on a calendar date (yyyy-MM-dd, clinic-local).
   */
  async getSlots(serviceId: string, date: string): Promise<AvailableSlot[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date must be yyyy-MM-dd');
    }

    const [service] = await this.db
      .select()
      .from(services)
      .where(and(eq(services.clinicId, this.clinicId), eq(services.id, serviceId)))
      .limit(1);
    if (!service) throw new NotFoundException('Service not found');

    const clinic = await this.clinicsRepo.getCurrent();
    const tz = clinic.timezone;

    const dayStart = new TZDate(`${date}T00:00:00`, tz);
    const weekday = dayStart.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
    const hours = clinic.settings?.workingHours?.[weekday];
    if (!hours) return []; // clinic closed that day

    const open = new TZDate(`${date}T${hours.open}:00`, tz);
    const close = new TZDate(`${date}T${hours.close}:00`, tz);

    const capacity = Math.max(1, (await this.professionalsRepo.listActive()).length);
    const occupying = await this.appointmentsRepo.listOccupying(open, close);
    const earliestStart = addMinutes(new Date(), MIN_LEAD_MINUTES);

    const slots: AvailableSlot[] = [];
    for (
      let start = open;
      addMinutes(start, service.durationMin) <= close;
      start = addMinutes(start, SLOT_STEP_MIN)
    ) {
      if (start < earliestStart) continue;
      const end = addMinutes(start, service.durationMin);
      const overlapping = occupying.filter(
        (a) => a.startsAt < end && a.endsAt > start,
      ).length;
      if (overlapping < capacity) {
        slots.push({ startsAt: start.toISOString(), endsAt: end.toISOString() });
      }
    }
    return slots;
  }

  /**
   * Books if the requested slot is still free — availability is re-checked
   * inside the booking call because the agent's earlier offer may be stale
   * (another contact can take the slot mid-conversation).
   */
  async book(params: {
    contactId: string;
    serviceId: string;
    startsAtISO: string;
    source: 'agent' | 'human';
  }): Promise<{ ok: true; appointmentId: string; endsAt: Date } | { ok: false; reason: string }> {
    const [service] = await this.db
      .select()
      .from(services)
      .where(and(eq(services.clinicId, this.clinicId), eq(services.id, params.serviceId)))
      .limit(1);
    if (!service) return { ok: false, reason: 'service_not_found' };

    // Strict ISO 8601 check: V8's Date parser is dangerously lenient (it
    // reads 'amanhã às 10' as Oct 2001) — an LLM-provided datetime must
    // match the shape the get_available_slots tool returned, nothing else.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(params.startsAtISO)) {
      return { ok: false, reason: 'invalid_datetime' };
    }
    const startsAt = new Date(params.startsAtISO);
    if (Number.isNaN(startsAt.getTime())) return { ok: false, reason: 'invalid_datetime' };

    const clinic = await this.clinicsRepo.getCurrent();
    const date = new TZDate(startsAt, clinic.timezone);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    const free = await this.getSlots(params.serviceId, dateStr);
    const match = free.find((s) => new Date(s.startsAt).getTime() === startsAt.getTime());
    if (!match) return { ok: false, reason: 'slot_taken' };

    const endsAt = addMinutes(startsAt, service.durationMin);
    const appointment = await this.appointmentsRepo.create({
      contactId: params.contactId,
      serviceId: params.serviceId,
      startsAt,
      endsAt,
      source: params.source,
    });
    return { ok: true, appointmentId: appointment.id, endsAt };
  }
}
