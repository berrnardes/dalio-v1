// Availability engine tests — SPEC §7. Wrong math here double-books a chair
// or turns away a paying client; timezone handling is where it would break
// silently (appointments are timestamptz, clinics think in wall-clock).
import { describe, expect, it } from 'vitest';
import { TZDate } from '@date-fns/tz';
import { AvailabilityService } from '../src/scheduling/availability.service';
import type { AppointmentsRepository } from '../src/scheduling/appointments.repository';
import type { ClinicsRepository } from '../src/scheduling/clinics.repository';
import type { ProfessionalsRepository } from '../src/scheduling/professionals.repository';
import { TenantContextService } from '../src/tenancy/tenant-context.service';
import type { Db } from '../src/db/db.module';

const TZ = 'America/Sao_Paulo';
// 2100-01-04 is a Monday — far future so the 60min lead filter never bites.
const MONDAY = '2100-01-04';

const clinic = {
  id: 'clinic-1',
  timezone: TZ,
  settings: { workingHours: { 1: { open: '09:00', close: '12:00' } } },
} as Awaited<ReturnType<ClinicsRepository['getCurrent']>>;

const service = { id: 'svc-1', clinicId: 'clinic-1', durationMin: 60 };

/** Minimal drizzle chain stub — the service only does select→from→where→limit. */
const fakeDb = {
  select: () => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([service]) }) }),
  }),
} as unknown as Db;

const at = (time: string, date = MONDAY) => new TZDate(`${date}T${time}:00`, TZ);

function makeService(opts: {
  professionals?: number;
  occupying?: Array<{ startsAt: Date; endsAt: Date }>;
  created?: Array<Record<string, unknown>>;
}) {
  const tenant = new TenantContextService();
  const svc = new AvailabilityService(
    fakeDb,
    tenant,
    { getCurrent: () => Promise.resolve(clinic) } as ClinicsRepository,
    {
      listActive: () => Promise.resolve(Array.from({ length: opts.professionals ?? 1 }, (_, i) => ({ id: `p${i}` }))),
    } as unknown as ProfessionalsRepository,
    {
      listOccupying: () => Promise.resolve(opts.occupying ?? []),
      create: (params: Record<string, unknown>) => {
        opts.created?.push(params);
        return Promise.resolve({ id: 'appt-new', ...params });
      },
    } as unknown as AppointmentsRepository,
  );
  const run = <T>(fn: () => Promise<T>) =>
    tenant.run({ clinicId: 'clinic-1', userId: 'test' }, fn);
  return { svc, run };
}

const localTimes = (slots: Array<{ startsAt: string }>) =>
  slots.map((s) => {
    const d = new TZDate(new Date(s.startsAt), TZ);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });

describe('AvailabilityService.getSlots', () => {
  it('offers the 30min grid that fits a 60min service inside working hours', async () => {
    const { svc, run } = makeService({});
    const slots = await run(() => svc.getSlots('svc-1', MONDAY));
    expect(localTimes(slots)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
  });

  it('removes slots overlapping an occupying appointment (capacity 1)', async () => {
    const { svc, run } = makeService({
      occupying: [{ startsAt: at('10:00'), endsAt: at('11:00') }],
    });
    const slots = await run(() => svc.getSlots('svc-1', MONDAY));
    expect(localTimes(slots)).toEqual(['09:00', '11:00']);
  });

  it('two professionals = two parallel chairs: one appointment blocks nothing', async () => {
    const { svc, run } = makeService({
      professionals: 2,
      occupying: [{ startsAt: at('10:00'), endsAt: at('11:00') }],
    });
    const slots = await run(() => svc.getSlots('svc-1', MONDAY));
    expect(localTimes(slots)).toHaveLength(5);
  });

  it('closed day returns no slots (workingHours has no entry)', async () => {
    const { svc, run } = makeService({});
    const sunday = '2100-01-03';
    expect(await run(() => svc.getSlots('svc-1', sunday))).toEqual([]);
  });

  it('rejects malformed dates before touching the calendar', async () => {
    const { svc, run } = makeService({});
    await expect(run(() => svc.getSlots('svc-1', '04/01/2100'))).rejects.toThrow(/yyyy-MM-dd/);
  });
});

describe('AvailabilityService.book', () => {
  it('books a free slot and returns the appointment id', async () => {
    const created: Array<Record<string, unknown>> = [];
    const { svc, run } = makeService({ created });
    const result = await run(() =>
      svc.book({
        contactId: 'c1',
        serviceId: 'svc-1',
        startsAtISO: at('09:00').toISOString(),
        source: 'agent',
      }),
    );
    expect(result).toMatchObject({ ok: true, appointmentId: 'appt-new' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ contactId: 'c1', source: 'agent' });
  });

  it('re-checks availability at booking time: a stale offer is refused', async () => {
    // The agent offered 10:00 earlier; someone else took it mid-conversation.
    const { svc, run } = makeService({
      occupying: [{ startsAt: at('10:00'), endsAt: at('11:00') }],
    });
    const result = await run(() =>
      svc.book({
        contactId: 'c1',
        serviceId: 'svc-1',
        startsAtISO: at('10:00').toISOString(),
        source: 'agent',
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'slot_taken' });
  });

  it('refuses garbage datetimes from the model', async () => {
    const { svc, run } = makeService({});
    const result = await run(() =>
      svc.book({ contactId: 'c1', serviceId: 'svc-1', startsAtISO: 'amanhã às 10', source: 'agent' }),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_datetime' });
  });
});
