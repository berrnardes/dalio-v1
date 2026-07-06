// Phase 6 integration — reactivation campaigns + the numbers subsystem,
// against real Postgres/Redis with a fake WAHA. Drives the risky machinery
// end to end: segment building with RECORDED suppressions, the dripped
// dispatch (send window + cap + interval), late re-suppression, conversion
// attribution through the appointment lifecycle, the ban-swap runbook, the
// canary kill-switch, warm-up ramp advancement, and the public /wa redirect.
import { randomUUID } from 'node:crypto';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { WahaApiClient } from '../../src/channels/providers/waha-api.client';
import { TenantContextService } from '../../src/tenancy/tenant-context.service';
import { SegmentBuilder } from '../../src/campaigns/segment.builder';
import { CampaignsController } from '../../src/campaigns/campaigns.controller';
import { CampaignsRepository } from '../../src/campaigns/campaigns.repository';
import { CampaignDispatchWorker } from '../../src/campaigns/campaign-dispatch.worker';
import { NumbersService } from '../../src/numbers/numbers.service';
import { AppointmentLifecycleService } from '../../src/reminders/appointment-lifecycle.service';
import { MetricsService } from '../../src/metrics/metrics.service';
import { currentMonth } from '../../src/metrics/month-window';

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
let baseUrl: string;
let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;
let tenant: TenantContextService;
let clinicId: string;
let channelId: string;
let serviceId: string;
let clinicSlug: string;
const fakeWaha = new FakeWahaApi();

beforeAll(async () => {
  [pgContainer, redisContainer] = await Promise.all([
    new GenericContainer('postgres:17-alpine')
      .withEnvironment({ POSTGRES_USER: 'cam', POSTGRES_PASSWORD: 'cam', POSTGRES_DB: 'cam' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/ready to accept connections/, 2))
      .start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);

  const dbUrl = `postgres://cam:cam@localhost:${pgContainer.getMappedPort(5432)}/cam`;
  process.env.DATABASE_URL = dbUrl;
  process.env.REDIS_URL = `redis://localhost:${redisContainer.getMappedPort(6379)}`;
  process.env.BETTER_AUTH_SECRET = 'campaigns-secret-with-at-least-32-chars!';
  process.env.BETTER_AUTH_URL = 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
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
  await app.listen(0); // the /wa redirect test needs a real socket
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  tenant = app.get(TenantContextService);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await sql?.end({ timeout: 5 });
  await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
}, 60_000);

afterEach(async () => {
  await sql`truncate campaign_recipients, campaigns, reminders, waitlist, messages, conversations, appointments, contacts, channels, numbers, services, clinics cascade`;
  fakeWaha.posts = [];
});

// ── Seed helpers ───────────────────────────────────────────────────────────

async function seedClinic() {
  clinicSlug = `cam-${randomUUID().slice(0, 8)}`;
  const [clinic] = await db
    .insert(schema.clinics)
    .values({
      name: 'Campanhas Clinic',
      slug: clinicSlug,
      // Full-day windows so neither the drip guard nor the availability
      // engine depends on when the suite runs.
      settings: {
        sendWindow: { start: '00:00', end: '23:59' },
        workingHours: Object.fromEntries(
          [0, 1, 2, 3, 4, 5, 6].map((d) => [d, { open: '00:00', close: '23:59' }]),
        ),
      },
    })
    .returning();
  clinicId = clinic!.id;
  // The attribution test books through the real availability engine —
  // capacity = active professionals.
  await db.insert(schema.professionals).values({ clinicId, name: 'Pro' });
  const [channel] = await db
    .insert(schema.channels)
    .values({ clinicId, provider: 'waha', externalId: clinicSlug, status: 'connected' })
    .returning();
  channelId = channel!.id;
  const [service] = await db
    .insert(schema.services)
    .values({
      clinicId,
      name: 'Alongamento de cílios',
      priceCents: 22_000,
      durationMin: 90,
      returnIntervalDays: 21,
    })
    .returning();
  serviceId = service!.id;
  await db.insert(schema.templates).values({
    clinicId,
    key: 'campaign_reactivation',
    category: 'marketing',
    variants: ['Oi {{nome}}! Hora do seu {{servico}} de novo?'],
  });
}

async function seedContact(name = 'Cliente') {
  const [c] = await db
    .insert(schema.contacts)
    .values({
      clinicId,
      name,
      phone: `+5511${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`,
      // Reactivation targets are past customers who consented (Phase 7: the
      // canContact gate fails campaign sends without consentAt).
      consentAt: new Date(),
    })
    .returning();
  return c!;
}

/** A completed visit `daysAgo` — segment fuel (returnIntervalDays=21). */
async function seedCompletedVisit(contactId: string, daysAgo: number) {
  const startsAt = new Date(Date.now() - daysAgo * 86_400_000);
  await db.insert(schema.appointments).values({
    clinicId,
    contactId,
    serviceId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3_600_000),
    status: 'completed',
    source: 'human',
  });
}

const inTenant = <T>(fn: () => Promise<T>) => tenant.run({ clinicId, userId: 'test' }, fn);

async function startCampaign(dailyCap = 10) {
  return inTenant(async () => {
    const campaign = await app
      .get(CampaignsRepository)
      .create({ name: 'Reativação', templateKey: 'campaign_reactivation', segment: null, dailyCap });
    await app.get(CampaignsController).start(campaign.id);
    return campaign;
  });
}

const runDispatch = () => app.get(CampaignDispatchWorker).process();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(150);
  }
  throw new Error('waitFor timed out');
}

// ── Segment + suppressions ─────────────────────────────────────────────────

describe('segment builder', () => {
  it('classifies overdue contacts and RECORDS each suppression reason', async () => {
    await seedClinic();
    const eligible = await seedContact('Elegível');
    const optedOut = await seedContact('OptOut');
    const booked = await seedContact('JáAgendou');
    const chatting = await seedContact('Conversando');
    const recent = await seedContact('ContatadoHáPouco');
    for (const c of [eligible, optedOut, booked, chatting, recent]) {
      await seedCompletedVisit(c.id, 40); // 40d ago, interval 21d → ~19d overdue
    }
    await db
      .update(schema.contacts)
      .set({ optOutAt: new Date() })
      .where(eq(schema.contacts.id, optedOut.id));
    const future = new Date(Date.now() + 3 * 86_400_000);
    await db.insert(schema.appointments).values({
      clinicId,
      contactId: booked.id,
      serviceId,
      startsAt: future,
      endsAt: new Date(future.getTime() + 3_600_000),
      status: 'scheduled',
      source: 'human',
    });
    await db.insert(schema.conversations).values({
      clinicId,
      contactId: chatting.id,
      channelId,
      lastInboundAt: new Date(Date.now() - 86_400_000),
    });
    await db.insert(schema.conversations).values({
      clinicId,
      contactId: recent.id,
      channelId,
      lastOutboundAt: new Date(Date.now() - 3 * 86_400_000),
    });

    const members = await inTenant(() => app.get(SegmentBuilder).build(null));
    const byContact = Object.fromEntries(members.map((m) => [m.contactId, m.suppressedReason]));

    expect(members).toHaveLength(5);
    expect(byContact[eligible.id]).toBeNull();
    expect(byContact[optedOut.id]).toBe('opted_out');
    expect(byContact[booked.id]).toBe('future_appointment');
    expect(byContact[chatting.id]).toBe('active_conversation');
    expect(byContact[recent.id]).toBe('recent_contact');
    expect(members[0]!.serviceName).toBe('Alongamento de cílios');
  }, 40_000);

  it('a contact inside the return interval is not in the segment', async () => {
    await seedClinic();
    const fresh = await seedContact();
    await seedCompletedVisit(fresh.id, 10); // interval is 21d — not due yet
    const members = await inTenant(() => app.get(SegmentBuilder).build(null));
    expect(members).toHaveLength(0);
  }, 40_000);
});

// ── Dispatch drip ──────────────────────────────────────────────────────────

describe('campaign dispatch', () => {
  it('sends ONE recipient per tick, arms the flow flag, and drips the next tick away', async () => {
    await seedClinic();
    const c1 = await seedContact('Ana');
    const c2 = await seedContact('Bia');
    await seedCompletedVisit(c1.id, 40);
    await seedCompletedVisit(c2.id, 50);
    const campaign = await startCampaign(10);

    await runDispatch();

    // Exactly one recipient sent; template rendered through the outbox.
    const sent = await sql`select contact_id from campaign_recipients where sent_at is not null`;
    expect(sent).toHaveLength(1);
    await waitFor(async () =>
      fakeWaha.posts.some(
        (p) => p.path === '/api/sendText' && String((p.body as { text: string }).text).includes('Hora do seu'),
      ),
    );
    const [convo] = await sql`select flow_context from conversations where contact_id = ${sent[0]!.contact_id}`;
    expect((convo!.flow_context as { kind: string; campaignId: string }).kind).toBe(
      'awaiting_campaign_reply',
    );
    expect((convo!.flow_context as { campaignId: string }).campaignId).toBe(campaign.id);

    // Immediate second tick: drip interval not yet elapsed — nothing goes out.
    await runDispatch();
    const sentAfter = await sql`select id from campaign_recipients where sent_at is not null`;
    expect(sentAfter).toHaveLength(1);
  }, 40_000);

  it('re-suppresses at send time: a booking after the snapshot wins over the drip', async () => {
    await seedClinic();
    const c = await seedContact();
    await seedCompletedVisit(c.id, 40);
    await startCampaign();

    // Snapshot says eligible; then the contact books before the first tick.
    const future = new Date(Date.now() + 2 * 86_400_000);
    await db.insert(schema.appointments).values({
      clinicId,
      contactId: c.id,
      serviceId,
      startsAt: future,
      endsAt: new Date(future.getTime() + 3_600_000),
      status: 'scheduled',
      source: 'human',
    });

    await runDispatch();

    const [r] = await sql`select sent_at, suppressed_reason from campaign_recipients`;
    expect(r!.sent_at).toBeNull();
    expect(r!.suppressed_reason).toBe('future_appointment');
    await sleep(300);
    expect(fakeWaha.posts.filter((p) => p.path === '/api/sendText')).toHaveLength(0);
  }, 40_000);

  it('closes the campaign when the snapshot is exhausted', async () => {
    await seedClinic();
    const campaign = await startCampaign(); // empty segment → no recipients
    await runDispatch();
    const [row] = await sql`select status from campaigns where id = ${campaign.id}`;
    expect(row!.status).toBe('done');
  }, 40_000);
});

// ── Conversion attribution ─────────────────────────────────────────────────

describe('conversion attribution', () => {
  it('a booking after a campaign send links convertedAppointmentId via the lifecycle', async () => {
    await seedClinic();
    const c = await seedContact('Volta');
    await seedCompletedVisit(c.id, 40);
    await startCampaign();
    await runDispatch();

    // The contact replies and books (agent path = lifecycle.book).
    const startsAt = new Date(Date.now() + 5 * 86_400_000);
    startsAt.setUTCHours(14, 0, 0, 0);
    const result = await inTenant(() =>
      app.get(AppointmentLifecycleService).book({
        contactId: c.id,
        serviceId,
        startsAtISO: startsAt.toISOString(),
        source: 'agent',
      }),
    );
    expect(result.ok).toBe(true);

    const [r] = await sql`select converted_appointment_id from campaign_recipients where contact_id = ${c.id}`;
    expect(r!.converted_appointment_id).not.toBeNull();

    // ...and the R$ dashboard sees the reactivation (hero metric #5).
    const summary = await inTenant(() =>
      app.get(MetricsService).summary(currentMonth('America/Sao_Paulo')),
    );
    expect(summary.reactivatedClients).toEqual({ count: 1, cents: 22_000 });
  }, 40_000);
});

// ── Numbers: ban swap, canary, warm-up, redirect ───────────────────────────

describe('numbers subsystem', () => {
  async function seedNumber(state: string, opts: { clinic?: boolean; isCanary?: boolean; warmupDaysAgo?: number } = {}) {
    const [n] = await db
      .insert(schema.numbers)
      .values({
        phone: `+5511${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`,
        ddd: '11',
        state: state as never,
        clinicId: opts.clinic ? clinicId : null,
        isCanary: opts.isCanary ?? false,
        warmupStartedAt: opts.warmupDaysAgo
          ? new Date(Date.now() - opts.warmupDaysAgo * 86_400_000)
          : null,
      })
      .returning();
    return n!;
  }

  it('ban swap: standby promoted, channel rewired to provisioning, succession recorded', async () => {
    await seedClinic();
    const active = await seedNumber('active', { clinic: true });
    const standby = await seedNumber('standby', { warmupDaysAgo: 30 });
    await sql`update channels set number_id = ${active.id} where id = ${channelId}`;

    const result = await app.get(NumbersService).replaceBanned(active.id);
    expect(result).not.toBeNull();

    const [old] = await sql`select state, replaced_by_id from numbers where id = ${active.id}`;
    expect(old!.state).toBe('banned');
    expect(old!.replaced_by_id).toBe(standby.id);
    const [neu] = await sql`select state, clinic_id from numbers where id = ${standby.id}`;
    expect(neu!.state).toBe('active');
    expect(neu!.clinic_id).toBe(clinicId);
    const [ch] = await sql`select number_id, status from channels where id = ${channelId}`;
    expect(ch!.number_id).toBe(standby.id);
    expect(ch!.status).toBe('provisioning');
  }, 40_000);

  it('a banned CANARY pauses every running campaign fleet-wide', async () => {
    await seedClinic();
    const canary = await seedNumber('active', { clinic: true, isCanary: true });
    void canary;
    const campaign = await startCampaign();

    await app.get(NumbersService).replaceBanned(canary.id).catch(() => null);

    const [row] = await sql`select status from campaigns where id = ${campaign.id}`;
    expect(row!.status).toBe('paused');
  }, 40_000);

  it('warm-up tick: quota follows the age ramp; ramp completion graduates to standby', async () => {
    await seedClinic();
    const young = await seedNumber('warming', { warmupDaysAgo: 5 });
    const done = await seedNumber('warming', { warmupDaysAgo: 25 });

    await app.get(NumbersService).warmupTick();

    const [y] = await sql`select daily_quota, state from numbers where id = ${young.id}`;
    expect(y!.state).toBe('warming');
    expect(y!.daily_quota).toBe(20); // 10 + 5d × 2
    const [d] = await sql`select daily_quota, state from numbers where id = ${done.id}`;
    expect(d!.state).toBe('standby');
    expect(d!.daily_quota).toBe(50);
  }, 40_000);

  it('GET /wa/<slug> 302s to the active number and 404s unknown slugs', async () => {
    await seedClinic();
    const active = await seedNumber('active', { clinic: true });

    const res = await fetch(`${baseUrl}/wa/${clinicSlug}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://wa.me/${active.phone.slice(1)}`);

    const miss = await fetch(`${baseUrl}/wa/nao-existe`, { redirect: 'manual' });
    expect(miss.status).toBe(404);
  }, 40_000);
});
