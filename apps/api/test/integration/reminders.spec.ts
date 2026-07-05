// Reminders / anti-no-show integration — SPEC §4 (Phase 4). Boots the full
// app against real Postgres + Redis and drives the engine end to end: the
// scanner sends a confirmation and arms the conversation; a deterministic "1"
// confirms the appointment; a cancellation cancels reminders and backfills the
// waitlist; and the outbound worker's PROACTIVE gates (opt-out, daily cap)
// hold — the inherited Phase 1 outbound-worker coverage lands here, where the
// first real proactive traffic exists.
import { randomUUID } from 'node:crypto';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { WahaApiClient } from '../../src/channels/providers/waha-api.client';
import { TenantContextService } from '../../src/tenancy/tenant-context.service';
import { RemindersScanWorker } from '../../src/reminders/reminders-scan.worker';
import { AppointmentLifecycleService } from '../../src/reminders/appointment-lifecycle.service';
import { OutboxService } from '../../src/outbound/outbox.service';
import { TURN_HANDLER } from '../../src/conversations/turn-handler';
import type { TurnHandler } from '../../src/conversations/turn-handler';

class FakeWahaApi {
  posts: Array<{ path: string; body?: unknown }> = [];
  post(path: string, body?: unknown): Promise<unknown> {
    this.posts.push({ path, body });
    return Promise.resolve({ id: `fake-${randomUUID()}` });
  }
}

let pgContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;
let tenant: TenantContextService;
let clinicId: string;
let channelId: string;
let serviceId: string;
const fakeWaha = new FakeWahaApi();

beforeAll(async () => {
  [pgContainer, redisContainer] = await Promise.all([
    new GenericContainer('postgres:17-alpine')
      .withEnvironment({ POSTGRES_USER: 'rem', POSTGRES_PASSWORD: 'rem', POSTGRES_DB: 'rem' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/ready to accept connections/, 2))
      .start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);

  const dbUrl = `postgres://rem:rem@localhost:${pgContainer.getMappedPort(5432)}/rem`;
  process.env.DATABASE_URL = dbUrl;
  process.env.REDIS_URL = `redis://localhost:${redisContainer.getMappedPort(6379)}`;
  process.env.BETTER_AUTH_SECRET = 'reminders-secret-with-at-least-32-chars!';
  process.env.BETTER_AUTH_URL = 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  // Agent unconfigured: the deterministic confirmation path must work WITHOUT
  // an API key (the no-show engine can't hinge on the LLM being configured).
  delete process.env.ANTHROPIC_API_KEY;

  sql = postgres(dbUrl, { max: 4 });
  db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: 'drizzle' });

  const { AppModule } = await import('../../src/app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WahaApiClient)
    .useValue(fakeWaha)
    .compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  app.enableShutdownHooks();
  await app.init();
  tenant = app.get(TenantContextService);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await sql?.end({ timeout: 5 });
  await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
}, 60_000);

afterEach(async () => {
  await sql`truncate reminders, waitlist, messages, conversations, appointments, contacts, channels, services, clinics cascade`;
  fakeWaha.posts = [];
});

// ── Seed helpers ───────────────────────────────────────────────────────────

async function seedClinic(opts: { sendWindow?: { start: string; end: string } } = {}) {
  const [clinic] = await db
    .insert(schema.clinics)
    .values({
      name: 'Rem Clinic',
      slug: `rem-${randomUUID().slice(0, 8)}`,
      settings: { sendWindow: opts.sendWindow ?? { start: '00:00', end: '23:59' } },
    })
    .returning();
  clinicId = clinic!.id;
  const [channel] = await db
    .insert(schema.channels)
    .values({ clinicId, provider: 'waha', externalId: `rem-${randomUUID().slice(0, 8)}`, status: 'connected' })
    .returning();
  channelId = channel!.id;
  const [service] = await db
    .insert(schema.services)
    .values({ clinicId, name: 'Limpeza de pele', priceCents: 18000, durationMin: 60 })
    .returning();
  serviceId = service!.id;
  await seedTemplates();
}

async function seedTemplates() {
  await db.insert(schema.templates).values([
    { clinicId, key: 'reminder_confirm_24h', category: 'utility', variants: ['Confirma seu horário de {{servico}} em {{data}} às {{hora}}?'] },
    { clinicId, key: 'reminder_3h', category: 'utility', variants: ['Seu {{servico}} é hoje às {{hora}}!'] },
    { clinicId, key: 'waitlist_slot_open', category: 'utility', variants: ['Abriu vaga de {{servico}} em {{data}} às {{hora}}!'] },
  ]);
}

async function seedContact(opts: { optedOut?: boolean; name?: string } = {}) {
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      clinicId,
      phone: `+5511${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`,
      name: opts.name ?? 'Cliente',
      optOutAt: opts.optedOut ? new Date() : null,
    })
    .returning();
  return contact!;
}

async function seedAppointment(contactId: string, startsAt: Date) {
  const [appt] = await db
    .insert(schema.appointments)
    .values({
      clinicId,
      contactId,
      serviceId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
      status: 'scheduled',
      source: 'agent',
    })
    .returning();
  return appt!;
}

async function seedDueReminder(appointmentId: string, kind: 'confirm_24h' | 'reminder_3h') {
  const [row] = await db
    .insert(schema.reminders)
    .values({ clinicId, appointmentId, kind, dueAt: new Date(Date.now() - 60_000) })
    .returning();
  return row!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(150);
  }
  throw new Error('waitFor timed out');
}
const runScan = () => app.get(RemindersScanWorker).process();
const inTenant = <T>(fn: () => Promise<T>) =>
  tenant.run({ clinicId, userId: 'test' }, fn);

async function reminderRow(id: string) {
  const [r] = await sql`select sent_at, cancelled_at, message_id from reminders where id = ${id}`;
  return r!;
}
async function conversationFor(contactId: string) {
  const [c] = await sql`select id, flow_context from conversations where contact_id = ${contactId} limit 1`;
  return c;
}

// ── Scanner → confirmation ─────────────────────────────────────────────────

describe('scanner sends a confirmation', () => {
  it('arms the conversation, marks the reminder sent, and dispatches the choice', async () => {
    await seedClinic();
    const contact = await seedContact({ name: 'Marina' });
    const appt = await seedAppointment(contact.id, new Date(Date.now() + 25 * 60 * 60 * 1000));
    const reminder = await seedDueReminder(appt.id, 'confirm_24h');

    await runScan();

    // Reminder marked sent + linked to an outbox message.
    const r = await reminderRow(reminder.id);
    expect(r.sent_at).not.toBeNull();
    expect(r.message_id).not.toBeNull();

    // Conversation created and armed to await a confirmation reply.
    const convo = await conversationFor(contact.id);
    expect(convo).toBeTruthy();
    expect((convo!.flow_context as { kind: string }).kind).toBe('awaiting_confirmation');

    // Outbound worker renders the choice and "sends" it via the fake WAHA.
    await waitFor(async () =>
      fakeWaha.posts.some(
        (p) => p.path === '/api/sendText' && String((p.body as { text: string }).text).includes('Confirma'),
      ),
    );
  }, 40_000);

  it('defers a reminder that is due outside the clinic send window', async () => {
    // Window that cannot contain "now" in the clinic tz (1-minute dead window).
    await seedClinic({ sendWindow: { start: '00:00', end: '00:01' } });
    const contact = await seedContact();
    const appt = await seedAppointment(contact.id, new Date(Date.now() + 25 * 60 * 60 * 1000));
    const reminder = await seedDueReminder(appt.id, 'confirm_24h');

    await runScan();

    // Left unsent (deferred to the next in-window tick), not dropped.
    const r = await reminderRow(reminder.id);
    expect(r.sent_at).toBeNull();
    expect(r.cancelled_at).toBeNull();
  }, 40_000);

  it('cancels (never sends) a reminder for an opted-out contact', async () => {
    await seedClinic();
    const contact = await seedContact({ optedOut: true });
    const appt = await seedAppointment(contact.id, new Date(Date.now() + 25 * 60 * 60 * 1000));
    const reminder = await seedDueReminder(appt.id, 'confirm_24h');

    await runScan();

    const r = await reminderRow(reminder.id);
    expect(r.cancelled_at).not.toBeNull();
    expect(r.sent_at).toBeNull();
    await sleep(400);
    expect(fakeWaha.posts.filter((p) => p.path === '/api/sendText')).toHaveLength(0);
  }, 40_000);
});

// ── Deterministic confirmation reply ───────────────────────────────────────

describe('confirmation reply confirms the appointment (no LLM)', () => {
  it('"1" → appointment confirmed + flag cleared', async () => {
    await seedClinic();
    const contact = await seedContact();
    const appt = await seedAppointment(contact.id, new Date(Date.now() + 25 * 60 * 60 * 1000));
    await seedDueReminder(appt.id, 'confirm_24h');
    await runScan();

    const convo = await conversationFor(contact.id);
    const handler = app.get<TurnHandler>(TURN_HANDLER);
    await inTenant(() =>
      handler.handleTurn({
        clinicId,
        conversationId: convo!.id as string,
        messages: [{ messageId: randomUUID(), text: '1', kind: 'text', timestamp: Date.now() }],
      }),
    );

    const [a] = await sql`select status from appointments where id = ${appt.id}`;
    expect(a!.status).toBe('confirmed');
    const [c] = await sql`select flow_context from conversations where id = ${convo!.id}`;
    expect((c!.flow_context as { kind: string }).kind).toBe('none');
  }, 40_000);
});

// ── Waitlist backfill on cancel ────────────────────────────────────────────

describe('cancel backfills the waitlist', () => {
  it('notifies a matching waiter and cancels the appointment reminders', async () => {
    await seedClinic();
    const booked = await seedContact({ name: 'Quem cancelou' });
    const waiter = await seedContact({ name: 'Quem espera' });
    const startsAt = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const appt = await seedAppointment(booked.id, startsAt);
    const reminder = await seedDueReminder(appt.id, 'confirm_24h');
    await db.insert(schema.waitlist).values({ clinicId, contactId: waiter.id, serviceId });

    const ok = await inTenant(() => app.get(AppointmentLifecycleService).cancel(appt.id));
    expect(ok).toBe(true);

    // Appointment reminders cancelled.
    const r = await reminderRow(reminder.id);
    expect(r.cancelled_at).not.toBeNull();

    // Waiter notified (row marked) and a message enqueued to them.
    await waitFor(async () => {
      const [w] = await sql`select notified_at from waitlist where contact_id = ${waiter.id}`;
      return w?.notified_at != null;
    });
    await waitFor(async () =>
      fakeWaha.posts.some(
        (p) => p.path === '/api/sendText' && String((p.body as { text: string }).text).includes('Abriu vaga'),
      ),
    );
  }, 40_000);
});

// ── Outbound worker proactive gating (inherited Phase 1 item) ──────────────

describe('outbound worker — proactive gates', () => {
  it('enforces the per-channel daily cap for proactive sends', async () => {
    await seedClinic();
    // Tighten the channel policy to a single proactive send/day.
    await sql`update channels set rate_policy = ${JSON.stringify({ maxPerDay: 1, minJitterMs: 1, maxJitterMs: 2 })}::jsonb where id = ${channelId}`;
    const c1 = await seedContact();
    const c2 = await seedContact();

    const send = (contactId: string) =>
      inTenant(async () => {
        const [convo] = await db
          .insert(schema.conversations)
          .values({ clinicId, contactId, channelId })
          .returning();
        return app.get(OutboxService).send({
          conversationId: convo!.id,
          channelId,
          intent: { kind: 'text', text: 'lembrete proativo' },
          source: 'reminder',
        });
      });

    const id1 = await send(c1.id);
    const id2 = await send(c2.id);

    // Exactly one leaves; the other is failed with the cap reason.
    await waitFor(async () => {
      const rows = await sql`select status from messages where id in (${id1}, ${id2})`;
      const statuses = rows.map((r) => r.status).sort();
      return statuses.includes('sent') && statuses.includes('failed');
    });
    const [failed] = await sql`select error from messages where status = 'failed'`;
    expect(JSON.stringify(failed!.error)).toContain('daily_cap');
  }, 40_000);
});
