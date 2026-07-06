// Phase 7 integration — beta hardening against real Postgres/Redis: LGPD
// erasure end to end (the tombstone must leave NOTHING sendable or readable),
// the campaign consent gate enforced at the outbound worker, the onboarding
// activation gate, the pilot scorecard math over real rows, and the extended
// /health surface.
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
import { ContactsController } from '../../src/conversations/contacts.controller';
import { OnboardingController } from '../../src/scheduling/onboarding.controller';
import { OutboxService } from '../../src/outbound/outbox.service';
import { MetricsService } from '../../src/metrics/metrics.service';

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
const fakeWaha = new FakeWahaApi();

beforeAll(async () => {
  [pgContainer, redisContainer] = await Promise.all([
    new GenericContainer('postgres:17-alpine')
      .withEnvironment({ POSTGRES_USER: 'p7', POSTGRES_PASSWORD: 'p7', POSTGRES_DB: 'p7' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/ready to accept connections/, 2))
      .start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);

  const dbUrl = `postgres://p7:p7@localhost:${pgContainer.getMappedPort(5432)}/p7`;
  process.env.DATABASE_URL = dbUrl;
  process.env.REDIS_URL = `redis://localhost:${redisContainer.getMappedPort(6379)}`;
  process.env.BETTER_AUTH_SECRET = 'phase7-secret-with-at-least-32-chars!!';
  process.env.BETTER_AUTH_URL = 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ALERT_WEBHOOK_URL;

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
  await app.listen(0);
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

async function seedClinic(status: 'active' | 'suspended' = 'active') {
  const [clinic] = await db
    .insert(schema.clinics)
    .values({
      name: 'P7 Clinic',
      slug: `p7-${randomUUID().slice(0, 8)}`,
      status,
      settings: {},
    })
    .returning();
  clinicId = clinic!.id;
  const [channel] = await db
    .insert(schema.channels)
    .values({ clinicId, provider: 'waha', externalId: `p7-${randomUUID().slice(0, 8)}`, status: 'connected' })
    .returning();
  channelId = channel!.id;
  const [service] = await db
    .insert(schema.services)
    .values({ clinicId, name: 'Limpeza', priceCents: 18_000, durationMin: 60 })
    .returning();
  serviceId = service!.id;
}

async function seedContact(opts: { consented?: boolean } = {}) {
  const [c] = await db
    .insert(schema.contacts)
    .values({
      clinicId,
      name: 'Cliente',
      phone: `+5511${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`,
      consentAt: opts.consented ? new Date() : null,
    })
    .returning();
  return c!;
}

const inTenant = <T>(fn: () => Promise<T>) => tenant.run({ clinicId, userId: 'test' }, fn);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(150);
  }
  throw new Error('waitFor timed out');
}

// ── LGPD erasure ───────────────────────────────────────────────────────────

describe('LGPD erasure', () => {
  it('tombstones the contact, purges message content, drops pending sends', async () => {
    await seedClinic();
    const c = await seedContact({ consented: true });
    const [convo] = await db
      .insert(schema.conversations)
      .values({ clinicId, contactId: c.id, channelId })
      .returning();
    await db.insert(schema.messages).values({
      clinicId,
      conversationId: convo!.id,
      direction: 'inbound',
      source: 'contact',
      kind: 'audio',
      body: { text: 'meu cpf é 123', mediaUrl: 'http://x/audio.ogg' },
      transcription: 'meu cpf é 123',
      status: 'delivered',
    });
    await db.insert(schema.waitlist).values({ clinicId, contactId: c.id, serviceId });
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ clinicId, name: 'R', templateKey: 'campaign_reactivation' })
      .returning();
    await db.insert(schema.campaignRecipients).values([
      { clinicId, campaignId: campaign!.id, contactId: c.id }, // pending → must go
      { clinicId, campaignId: campaign!.id, contactId: c.id, sentAt: new Date() }, // audit → stays
    ]);

    await inTenant(() => app.get(ContactsController).erase(c.id));

    const [erased] = await sql`select phone, name, consent_at, opt_out_at from contacts where id = ${c.id}`;
    expect(erased!.phone).toBe(`erased:${c.id}`);
    expect(erased!.name).toBeNull();
    expect(erased!.consent_at).toBeNull();
    expect(erased!.opt_out_at).not.toBeNull(); // nothing can ever be sent again

    const [msg] = await sql`select body, transcription from messages where conversation_id = ${convo!.id}`;
    expect(msg!.body).toEqual({});
    expect(msg!.transcription).toBeNull();

    expect(await sql`select 1 from waitlist where contact_id = ${c.id}`).toHaveLength(0);
    const recipients = await sql`select sent_at from campaign_recipients where contact_id = ${c.id}`;
    expect(recipients).toHaveLength(1); // only the already-sent audit row
    expect(recipients[0]!.sent_at).not.toBeNull();
  }, 40_000);
});

// ── Consent gate at the outbound worker ────────────────────────────────────

describe('campaign consent gate (canContact at send time)', () => {
  it('fails a campaign send to a non-consented contact; consented one leaves', async () => {
    await seedClinic();
    const noConsent = await seedContact();
    const consented = await seedContact({ consented: true });

    const send = (contactId: string) =>
      inTenant(async () => {
        const [convo] = await db
          .insert(schema.conversations)
          .values({ clinicId, contactId, channelId })
          .returning();
        return app.get(OutboxService).send({
          conversationId: convo!.id,
          channelId,
          intent: { kind: 'text', text: 'campanha' },
          source: 'campaign',
        });
      });

    const blocked = await send(noConsent.id);
    const allowed = await send(consented.id);

    await waitFor(async () => {
      const rows = await sql`select id, status from messages where id in (${blocked}, ${allowed})`;
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
      return byId[blocked] === 'failed' && byId[allowed] === 'sent';
    });
    const [failed] = await sql`select error from messages where id = ${blocked}`;
    expect(JSON.stringify(failed!.error)).toContain('no_consent');
  }, 40_000);
});

// ── Onboarding activation gate ─────────────────────────────────────────────

describe('onboarding activation gate', () => {
  it('refuses activation until the checklist is green, then flips the clinic', async () => {
    await seedClinic('suspended');
    const controller = app.get(OnboardingController);

    await expect(inTenant(() => controller.activate())).rejects.toThrow(/Onboarding incomplete/);

    await inTenant(() =>
      controller.patch({ redirectInBio: true, adsUpdated: true, inboxTrained: true, catalogFilled: true }),
    );
    const result = await inTenant(() => controller.activate());
    expect(result.status).toBe('active');

    const [clinic] = await sql`select status from clinics where id = ${clinicId}`;
    expect(clinic!.status).toBe('active');
  }, 40_000);

  it('a green checklist without a connected channel still does not activate', async () => {
    await seedClinic('suspended');
    await sql`update channels set status = 'disconnected' where id = ${channelId}`;
    const controller = app.get(OnboardingController);
    await inTenant(() =>
      controller.patch({ redirectInBio: true, adsUpdated: true, inboxTrained: true, catalogFilled: true }),
    );
    await expect(inTenant(() => controller.activate())).rejects.toThrow(/No connected/);
  }, 40_000);
});

// ── Pilot scorecard ────────────────────────────────────────────────────────

describe('pilot scorecard', () => {
  it('computes no-show rate over DECIDED appointments and flags goals', async () => {
    await seedClinic();
    const c = await seedContact();
    // Fixed past month (like the metrics spec) so the suite never flakes
    // near a month boundary. 3 completed + 1 no-show = 25% rate; the
    // scheduled appointment must NOT enter the denominator (it never had
    // the chance to no-show).
    const june = (day: number) => new Date(`2026-06-${String(day).padStart(2, '0')}T14:00:00-03:00`);
    const seed = (status: string, source: string, day: number) =>
      db.insert(schema.appointments).values({
        clinicId,
        contactId: c.id,
        serviceId,
        startsAt: june(day),
        endsAt: new Date(june(day).getTime() + 3_600_000),
        status: status as never,
        source,
        createdAt: june(day - 5),
      });
    await seed('completed', 'human', 10);
    await seed('completed', 'human', 11);
    await seed('completed', 'human', 12);
    await seed('no_show', 'human', 13);
    await seed('scheduled', 'agent', 28); // agent booking: counts for volume, not for the rate

    const status = await inTenant(() => app.get(MetricsService).pilotStatus('2026-06'));

    expect(status.noShowRatePct.actual).toBe(25);
    expect(status.noShowRatePct.met).toBe(false); // goal default ≤10
    expect(status.underSixtySecondsPct.actual).toBeNull(); // no leads yet
    expect(status.underSixtySecondsPct.met).toBeNull(); // no data ≠ goal met
    expect(status.autonomousBookings.actual).toBe(1);
    expect(status.autonomousBookings.met).toBe(false); // goal default ≥20
  }, 40_000);
});

// ── /health ────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('reports db/redis/channels/queues; disconnected session degrades', async () => {
    await seedClinic();
    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.db).toBe(true);
    expect(body.redis).toBe(true);
    expect(body.status).toBe('ok');
    expect(body.channels).toEqual({ expected: 1, connected: 1 });
    for (const q of ['inbound', 'agent', 'outbound']) {
      expect(body.queues as Record<string, unknown>).toHaveProperty(q);
    }

    await sql`update channels set status = 'failed' where id = ${channelId}`;
    const degraded = (await (await fetch(`${baseUrl}/health`)).json()) as Record<string, unknown>;
    expect(degraded.status).toBe('degraded');
    expect(degraded.channels).toEqual({ expected: 1, connected: 0 });
  }, 40_000);
});
