// Reminders engine unit tests — SPEC §4 (Phase 4). The pure logic that, if
// wrong, either spams contacts (bad dueAts / no send-window) or silently drops
// the no-show defense (missed cancellation / misread confirmation).
import { describe, expect, it, vi } from 'vitest';
import { RemindersRepository } from '../src/reminders/reminders.repository';
import { ConfirmationBuilder, CONFIRMATION_CHOICE_OPTIONS } from '../src/reminders/confirmation.builder';
import { isWithinSendWindow } from '../src/reminders/send-window';
import { AppointmentLifecycleService } from '../src/reminders/appointment-lifecycle.service';
import { TenantContextService } from '../src/tenancy/tenant-context.service';
import type { Db } from '../src/db/db.module';

const TZ = 'America/Sao_Paulo';

// ── generateForAppointment: correct dueAts, skip already-past ───────────────

function makeRemindersRepo() {
  let captured: Array<Record<string, unknown>> = [];
  const fakeDb = {
    insert: () => ({
      values: (rows: Array<Record<string, unknown>>) => ({
        returning: () => {
          captured = rows;
          return Promise.resolve(rows.map((r, i) => ({ id: `r${i}`, ...r })));
        },
      }),
    }),
  } as unknown as Db;
  const tenant = new TenantContextService();
  const repo = new RemindersRepository(fakeDb, tenant);
  const run = <T>(fn: () => Promise<T>) => tenant.run({ clinicId: 'clinic-1', userId: 't' }, fn);
  return { repo, run, captured: () => captured };
}

describe('RemindersRepository.generateForAppointment', () => {
  it('creates the full cadence for a far-future appointment', async () => {
    const { repo, run, captured } = makeRemindersRepo();
    const startsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // +3 days
    const rows = await run(() => repo.generateForAppointment({ appointmentId: 'a1', startsAt }));

    expect(rows).toHaveLength(3);
    const byKind = Object.fromEntries(captured().map((r) => [r.kind, r.dueAt as Date]));
    expect((byKind.confirm_24h as Date).getTime()).toBe(startsAt.getTime() - 24 * 60 * 60 * 1000);
    expect((byKind.reminder_3h as Date).getTime()).toBe(startsAt.getTime() - 3 * 60 * 60 * 1000);
    expect((byKind.at_risk_2h as Date).getTime()).toBe(startsAt.getTime() - 2 * 60 * 60 * 1000);
  });

  it('skips reminders whose dueAt already passed (near booking)', async () => {
    const { repo, run, captured } = makeRemindersRepo();
    // 200min out: confirm_24h (T-24h) is in the past; only reminder_3h (T-3h,
    // = +20min) and at_risk_2h (T-2h, = +80min) survive.
    const startsAt = new Date(Date.now() + 200 * 60 * 1000);
    const rows = await run(() => repo.generateForAppointment({ appointmentId: 'a1', startsAt }));

    expect(rows).toHaveLength(2);
    expect(captured().map((r) => r.kind).sort()).toEqual(['at_risk_2h', 'reminder_3h']);
  });

  it('honors per-clinic offset overrides', async () => {
    const { repo, run, captured } = makeRemindersRepo();
    const startsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await run(() =>
      repo.generateForAppointment({ appointmentId: 'a1', startsAt, offsets: { confirm24h: 48 * 60 } }),
    );
    const confirm = captured().find((r) => r.kind === 'confirm_24h')!.dueAt as Date;
    expect(confirm.getTime()).toBe(startsAt.getTime() - 48 * 60 * 60 * 1000);
  });
});

// ── confirmation reply parsing (deterministic, never the LLM) ───────────────

describe('ConfirmationBuilder.parseReply', () => {
  const opts = CONFIRMATION_CHOICE_OPTIONS;
  it('maps the digit to the option at that position', () => {
    expect(ConfirmationBuilder.parseReply('1', opts)).toBe('confirm');
    expect(ConfirmationBuilder.parseReply('2', opts)).toBe('reschedule');
    expect(ConfirmationBuilder.parseReply('3', opts)).toBe('cancel');
  });
  it('maps the label case/accent-insensitively', () => {
    expect(ConfirmationBuilder.parseReply('Confirmar', opts)).toBe('confirm');
    expect(ConfirmationBuilder.parseReply('cancelar', opts)).toBe('cancel');
  });
  it('returns null for anything not a clear choice', () => {
    expect(ConfirmationBuilder.parseReply('na verdade quanto custa?', opts)).toBeNull();
    expect(ConfirmationBuilder.parseReply('9', opts)).toBeNull();
  });
});

// ── send window: "nothing at 3am", deferral not drop ───────────────────────

describe('isWithinSendWindow', () => {
  const settings = { sendWindow: { start: '08:00', end: '20:00' } };
  const at = (hhmm: string) => new Date(`2026-07-06T${hhmm}:00-03:00`); // clinic tz offset

  it('is true inside the window, false outside', () => {
    expect(isWithinSendWindow(settings, TZ, at('10:00'))).toBe(true);
    expect(isWithinSendWindow(settings, TZ, at('03:00'))).toBe(false);
    expect(isWithinSendWindow(settings, TZ, at('21:30'))).toBe(false);
  });
  it('uses the default window when unset', () => {
    expect(isWithinSendWindow(null, TZ, at('09:00'))).toBe(true);
    expect(isWithinSendWindow(null, TZ, at('05:00'))).toBe(false);
  });
});

// ── lifecycle cancel: reminders cancelled + waitlist backfilled, once ───────

describe('AppointmentLifecycleService.cancel', () => {
  function makeLifecycle(cancelReturns: unknown) {
    const appointmentsRepo = { cancel: vi.fn().mockResolvedValue(cancelReturns) };
    const remindersRepo = { cancelForAppointment: vi.fn().mockResolvedValue(undefined) };
    const clinicsRepo = { getCurrent: vi.fn().mockResolvedValue({ id: 'c1', timezone: TZ }) };
    const servicesRepo = { getById: vi.fn().mockResolvedValue({ name: 'Limpeza' }) };
    const waitlist = { onSlotFreed: vi.fn().mockResolvedValue(undefined) };
    const svc = new AppointmentLifecycleService(
      {} as never,
      appointmentsRepo as never,
      clinicsRepo as never,
      servicesRepo as never,
      remindersRepo as never,
      waitlist as never,
    );
    return { svc, appointmentsRepo, remindersRepo, waitlist };
  }

  it('cancels reminders and backfills when a slot was actually freed', async () => {
    const freed = { serviceId: 'svc-1', startsAt: new Date('2026-07-10T14:00:00Z') };
    const { svc, remindersRepo, waitlist } = makeLifecycle(freed);

    expect(await svc.cancel('appt-1')).toBe(true);
    expect(remindersRepo.cancelForAppointment).toHaveBeenCalledWith('appt-1');
    expect(waitlist.onSlotFreed).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'svc-1', serviceName: 'Limpeza', slotStart: freed.startsAt }),
    );
  });

  it('does nothing when the appointment was already gone (idempotent)', async () => {
    const { svc, remindersRepo, waitlist } = makeLifecycle(undefined);
    expect(await svc.cancel('appt-1')).toBe(false);
    expect(remindersRepo.cancelForAppointment).not.toHaveBeenCalled();
    expect(waitlist.onSlotFreed).not.toHaveBeenCalled();
  });
});
