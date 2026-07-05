// Metrics summary integration — SPEC §7 (Phase 5). Runs the real SQL
// aggregations against real Postgres over a seeded month and asserts every
// hero metric's R$ math: agent bookings valued and filtered, recovered
// no-shows requiring a SENT confirmation reminder, first-response latency
// from message timestamps, and after-hours leads classified + converted.
//
// Boots only Db/Tenancy/Metrics modules — the metrics engine is read-only,
// so no Redis, no queues, no fake WAHA. Keep it that way: if this spec ever
// needs a queue, the dashboard grew a write path it must not have.
import { randomUUID } from 'node:crypto';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { DbModule } from '../../src/db/db.module';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import { TenantContextService } from '../../src/tenancy/tenant-context.service';
import { MetricsModule } from '../../src/metrics/metrics.module';
import { MetricsService } from '../../src/metrics/metrics.service';

// ── Fixed month under measurement: June 2026, São Paulo ────────────────────
// 2026-06-10 is a Wednesday; the seeded clinic only opens Wednesdays
// 09:00–19:00, so out-of-hours timestamps are deterministic whenever the
// suite runs.
const MONTH = '2026-06';
const at = (day: number, hhmm: string) => new Date(`2026-06-${String(day).padStart(2, '0')}T${hhmm}:00-03:00`);

let pgContainer: StartedTestContainer;
let app: INestApplication;
let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;
let tenant: TenantContextService;

beforeAll(async () => {
  pgContainer = await new GenericContainer('postgres:17-alpine')
    .withEnvironment({ POSTGRES_USER: 'met', POSTGRES_PASSWORD: 'met', POSTGRES_DB: 'met' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/ready to accept connections/, 2))
    .start();

  const dbUrl = `postgres://met:met@localhost:${pgContainer.getMappedPort(5432)}/met`;
  process.env.DATABASE_URL = dbUrl;

  sql = postgres(dbUrl, { max: 2 });
  db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: 'drizzle' });

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      DbModule,
      TenancyModule,
      MetricsModule,
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  app.enableShutdownHooks();
  await app.init();
  tenant = app.get(TenantContextService);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await sql?.end({ timeout: 5 });
  await pgContainer?.stop();
}, 60_000);

// ── One seeded month covering all four metrics ─────────────────────────────

async function seedMonth() {
  const [clinic] = await db
    .insert(schema.clinics)
    .values({
      name: 'Métricas Clinic',
      slug: `met-${randomUUID().slice(0, 8)}`,
      settings: { workingHours: { 3: { open: '09:00', close: '19:00' } }, noShowRatePct: 20 },
    })
    .returning();
  const clinicId = clinic!.id;

  const [channel] = await db
    .insert(schema.channels)
    .values({ clinicId, provider: 'waha', externalId: `met-${randomUUID().slice(0, 8)}`, status: 'connected' })
    .returning();

  const [service] = await db
    .insert(schema.services)
    .values({ clinicId, name: 'Limpeza de pele', priceCents: 18_000, durationMin: 60 })
    .returning();
  const serviceId = service!.id;

  const contact = async () => {
    const [c] = await db
      .insert(schema.contacts)
      .values({ clinicId, phone: `+5511${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}` })
      .returning();
    return c!;
  };

  const appointment = async (
    contactId: string,
    opts: { status: string; source: string; createdAt: Date; startsAt?: Date },
  ) => {
    const startsAt = opts.startsAt ?? at(24, '14:00');
    const [a] = await db
      .insert(schema.appointments)
      .values({
        clinicId,
        contactId,
        serviceId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        status: opts.status as never,
        source: opts.source,
        createdAt: opts.createdAt,
      })
      .returning();
    return a!;
  };

  const conversationWithMessages = async (
    contactId: string,
    rows: Array<{ direction: 'inbound' | 'outbound'; status: string; createdAt: Date }>,
  ) => {
    const [convo] = await db
      .insert(schema.conversations)
      .values({ clinicId, contactId, channelId: channel!.id })
      .returning();
    for (const r of rows) {
      await db.insert(schema.messages).values({
        clinicId,
        conversationId: convo!.id,
        direction: r.direction,
        source: r.direction === 'inbound' ? 'contact' : 'agent',
        kind: 'text',
        body: { text: 'x' },
        status: r.status as never,
        createdAt: r.createdAt,
      });
    }
    return convo!;
  };

  // Hero #1 — agent bookings: two captured (2 × R$180), one cancelled
  // (excluded) and one human booking (excluded).
  const cIn = await contact(); // also the in-hours lead below
  const cOut = await contact(); // also the after-hours lead below
  await appointment(cIn.id, { status: 'scheduled', source: 'agent', createdAt: at(10, '14:05') });
  await appointment(cOut.id, { status: 'confirmed', source: 'agent', createdAt: at(11, '10:00') });
  await appointment(cIn.id, { status: 'cancelled', source: 'agent', createdAt: at(12, '10:00') });
  await appointment(cIn.id, { status: 'scheduled', source: 'human', createdAt: at(12, '11:00') });

  // Hero #2 — recovered no-shows: one appointment confirmed after a SENT
  // confirmation reminder; one confirmed appointment with only an UNSENT
  // reminder (not the engine's win — excluded).
  const confirmed = await appointment(cIn.id, {
    status: 'confirmed',
    source: 'human',
    createdAt: at(20, '10:00'),
    startsAt: at(24, '16:00'),
  });
  await db.insert(schema.reminders).values({
    clinicId,
    appointmentId: confirmed.id,
    kind: 'confirm_24h',
    dueAt: at(23, '16:00'),
    sentAt: at(23, '16:01'),
  });
  const confirmedNoReminder = await appointment(cIn.id, {
    status: 'confirmed',
    source: 'human',
    createdAt: at(20, '11:00'),
    startsAt: at(25, '16:00'),
  });
  await db.insert(schema.reminders).values({
    clinicId,
    appointmentId: confirmedNoReminder.id,
    kind: 'confirm_24h',
    dueAt: at(24, '16:00'),
    sentAt: null,
  });

  // Heroes #3/#4 — leads. Wednesday June 10th: one lead inside working hours
  // (14:00, answered in 30s), one after close (22:00, answered in 90s), one
  // conversation WE opened (reminder first — excluded from response math),
  // and one unanswered in-hours lead (no latency yet).
  await conversationWithMessages(cIn.id, [
    { direction: 'inbound', status: 'delivered', createdAt: at(10, '14:00') },
    { direction: 'outbound', status: 'sent', createdAt: new Date(at(10, '14:00').getTime() + 30_000) },
  ]);
  await conversationWithMessages(cOut.id, [
    { direction: 'inbound', status: 'delivered', createdAt: at(10, '22:00') },
    { direction: 'outbound', status: 'sent', createdAt: new Date(at(10, '22:00').getTime() + 90_000) },
  ]);
  const cReminded = await contact();
  await conversationWithMessages(cReminded.id, [
    { direction: 'outbound', status: 'sent', createdAt: at(9, '10:00') },
    { direction: 'inbound', status: 'delivered', createdAt: at(9, '10:05') },
  ]);
  const cUnanswered = await contact();
  await conversationWithMessages(cUnanswered.id, [
    { direction: 'inbound', status: 'delivered', createdAt: at(10, '15:00') },
  ]);

  return { clinicId };
}

describe('GET /metrics/summary math', () => {
  it('computes all four hero metrics over the seeded month', async () => {
    const { clinicId } = await seedMonth();
    const summary = await tenant.run({ clinicId, userId: 'test' }, () =>
      app.get(MetricsService).summary(MONTH),
    );

    // #1 — two captured agent bookings × R$180; cancelled + human excluded.
    expect(summary.autonomousBookings).toEqual({ count: 2, cents: 36_000 });

    // #2 — one confirmed-after-sent-reminder × R$180 × 20% baseline.
    expect(summary.recoveredNoShows).toEqual({
      count: 1,
      estimatedCents: 3_600,
      noShowRatePct: 20,
    });

    // #3 — answered leads: 30s and 90s (reminder-initiated and unanswered
    // conversations excluded). Median 60s, half under a minute.
    expect(summary.firstResponse).toEqual({
      medianSeconds: 60,
      underSixtySecondsPct: 50,
      conversationsMeasured: 2,
    });

    // #4 — one 22:00 lead (clinic closes 19:00); its contact booked one
    // agent appointment in the month (R$180).
    expect(summary.afterHoursLeads).toEqual({ count: 1, convertedCount: 1, cents: 18_000 });
  }, 40_000);

  it('an empty month reports zeros and honest nulls', async () => {
    const [clinic] = await db
      .insert(schema.clinics)
      .values({ name: 'Vazia', slug: `met-${randomUUID().slice(0, 8)}`, settings: {} })
      .returning();
    const summary = await tenant.run({ clinicId: clinic!.id, userId: 'test' }, () =>
      app.get(MetricsService).summary(MONTH),
    );

    expect(summary.autonomousBookings).toEqual({ count: 0, cents: 0 });
    expect(summary.recoveredNoShows.count).toBe(0);
    expect(summary.firstResponse.medianSeconds).toBeNull();
    expect(summary.afterHoursLeads).toEqual({ count: 0, convertedCount: 0, cents: 0 });
  }, 40_000);
});
