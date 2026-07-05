// Inbox integration — Phase 3 (SPEC §7). Boots the full app against real
// Postgres/Redis and exercises the inbox as the dashboard does: real
// Better-auth session (sign-up → organization → set-active), real guards,
// real SSE socket, and the real outbound worker completing approved sends.
// The inbox is the clinic's only human channel — an auth or takeover bug
// here strands every conversation the agent hands off.
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

/** WAHA network stub — outbound sends and typing land here, not on HTTP. */
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
let clinicId: string;
let channelId: string;
let cookie: string;
const fakeWaha = new FakeWahaApi();

beforeAll(async () => {
  [pgContainer, redisContainer] = await Promise.all([
    new GenericContainer('postgres:17-alpine')
      .withEnvironment({ POSTGRES_USER: 'inbox', POSTGRES_PASSWORD: 'inbox', POSTGRES_DB: 'inbox' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/ready to accept connections/, 2))
      .start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);

  const dbUrl = `postgres://inbox:inbox@localhost:${pgContainer.getMappedPort(5432)}/inbox`;
  process.env.DATABASE_URL = dbUrl;
  process.env.REDIS_URL = `redis://localhost:${redisContainer.getMappedPort(6379)}`;
  process.env.BETTER_AUTH_SECRET = 'inbox-secret-with-at-least-32-characters!';
  process.env.BETTER_AUTH_URL = 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  // The agent must stay unconfigured: these tests own the message rows and
  // an ambient key on the dev machine would inject real LLM turns.
  delete process.env.ANTHROPIC_API_KEY;

  sql = postgres(dbUrl, { max: 2 });
  db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: 'drizzle' });

  const [clinic] = await db
    .insert(schema.clinics)
    .values({ name: 'Inbox Clinic', slug: 'inbox-clinic' })
    .returning();
  clinicId = clinic!.id;
  const [channel] = await db
    .insert(schema.channels)
    .values({ clinicId, provider: 'waha', externalId: 'inbox-session', status: 'connected' })
    .returning();
  channelId = channel!.id;

  // Env must exist before AppModule's ConfigModule decorator evaluates.
  const { AppModule } = await import('../../src/app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WahaApiClient)
    .useValue(fakeWaha)
    .compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  app.enableShutdownHooks();
  await app.listen(0);
  baseUrl = await app.getUrl();

  // Real session, real tenancy: sign-up → organization → set-active is
  // exactly the dashboard's path to a clinicId (TenantGuard resolves
  // authOrgId → clinic). Fabricating a session here would leave the guard
  // chain — the thing most worth testing — unexercised.
  cookie = await signUp('owner@inbox.test', 'inbox-test-123', 'Owner');
  const org = await authedJson<{ id: string }>('/api/auth/organization/create', {
    name: 'Inbox Clinic',
    slug: 'inbox-clinic-org',
  });
  // Bridge the auth org to the clinic (Phase 0's clinics.authOrgId), then
  // activate it — TenantGuard resolves the session's active org from here on.
  await db.update(schema.clinics).set({ authOrgId: org.id }).where(eq(schema.clinics.id, clinicId));
  await authedJson('/api/auth/organization/set-active', { organizationId: org.id });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await sql?.end({ timeout: 5 });
  await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
}, 60_000);

afterEach(async () => {
  await sql`truncate messages, conversations, appointments, waitlist, reminders, contacts cascade`;
  fakeWaha.posts = [];
});

// ── HTTP helpers ─────────────────────────────────────────────────────────

async function signUp(email: string, password: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  expect(res.status).toBe(200);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
  expect(cookies.length).toBeGreaterThan(0);
  return cookies.join('; ');
}

async function authedJson<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(res.status).toBeLessThan(300);
  return (await res.json()) as T;
}

function api(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}/api/v1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', cookie, ...(init.headers ?? {}) },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(150);
  }
  throw new Error('waitFor timed out');
}

// ── Seed helpers (direct inserts: pipeline mechanics are Phase 1's suite) ──

let phoneSeq = 0;
async function seedConversation() {
  phoneSeq += 1;
  const [contact] = await db
    .insert(schema.contacts)
    .values({ clinicId, phone: `+55119999${String(phoneSeq).padStart(5, '0')}` })
    .returning();
  const [convo] = await db
    .insert(schema.conversations)
    .values({ clinicId, contactId: contact!.id, channelId, lastInboundAt: new Date() })
    .returning();
  return { contact: contact!, convo: convo! };
}

async function seedInbound(conversationId: string, text: string) {
  const [row] = await db
    .insert(schema.messages)
    .values({
      clinicId,
      conversationId,
      direction: 'inbound',
      source: 'contact',
      kind: 'text',
      body: { text },
      providerMessageId: `pm-${randomUUID()}`,
      status: 'delivered',
    })
    .returning();
  return row!;
}

async function seedDraft(conversationId: string, text: string) {
  const [row] = await db
    .insert(schema.messages)
    .values({
      clinicId,
      conversationId,
      direction: 'outbound',
      source: 'agent',
      kind: 'text',
      body: {},
      intent: { kind: 'text', text },
      status: 'draft',
    })
    .returning();
  return row!;
}

async function messageStatus(id: string): Promise<string> {
  const [row] = await sql`select status from messages where id = ${id}`;
  return row!.status as string;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('auth boundary', () => {
  it('rejects anonymous access to the inbox', async () => {
    const res = await fetch(`${baseUrl}/api/v1/conversations`);
    expect(res.status).toBe(401);
  });
});

describe('conversation list and timeline', () => {
  it('lists open conversations with contact and last-message preview', async () => {
    const { contact, convo } = await seedConversation();
    await seedInbound(convo.id, 'oi, vocês fazem limpeza de pele?');

    const res = await api('/conversations');
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: convo.id,
      contactPhone: contact.phone,
      pendingDrafts: 0,
    });
    expect((list[0]!.lastMessage as Record<string, unknown>).preview).toBe(
      'oi, vocês fazem limpeza de pele?',
    );
  });

  it('pages the timeline with the uuidv7 cursor', async () => {
    const { convo } = await seedConversation();
    const first = await seedInbound(convo.id, 'primeira');
    await seedInbound(convo.id, 'segunda');

    const res = await api(`/conversations/${convo.id}/messages?limit=1`);
    const page = (await res.json()) as Array<{ id: string; body: { text: string } }>;
    expect(page).toHaveLength(1);
    expect(page[0]!.body.text).toBe('segunda');

    const older = await api(`/conversations/${convo.id}/messages?before=${page[0]!.id}`);
    const olderPage = (await older.json()) as Array<{ id: string }>;
    expect(olderPage.map((m) => m.id)).toEqual([first.id]);
  });
});

describe('human takeover', () => {
  it('a human reply sends through the outbox and auto-pauses the agent', async () => {
    const { convo } = await seedConversation();

    const res = await api(`/conversations/${convo.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: 'Olá! Aqui é a Ana da clínica.' }),
    });
    expect(res.status).toBe(201);
    const { messageId } = (await res.json()) as { messageId: string };

    // The real outbound worker (FIFO, pacing, canContact) completes the send.
    await waitFor(async () => (await messageStatus(messageId)) === 'sent');
    expect(
      fakeWaha.posts.some(
        (p) =>
          p.path === '/api/sendText' &&
          (p.body as { text: string }).text === 'Olá! Aqui é a Ana da clínica.',
      ),
    ).toBe(true);

    const [row] = await sql`select paused_until, paused_by_user_id from conversations
      where id = ${convo.id}`;
    expect(new Date(row!.paused_until as string).getTime()).toBeGreaterThan(Date.now());
    expect(row!.paused_by_user_id).not.toBeNull();
  });

  it('pause and resume flip the agent state explicitly', async () => {
    const { convo } = await seedConversation();

    await api(`/conversations/${convo.id}/pause`, { method: 'POST', body: JSON.stringify({}) });
    let [row] = await sql`select paused_until from conversations where id = ${convo.id}`;
    expect(row!.paused_until).not.toBeNull();

    await api(`/conversations/${convo.id}/resume`, { method: 'POST' });
    [row] = await sql`select paused_until from conversations where id = ${convo.id}`;
    expect(row!.paused_until).toBeNull();
  });
});

describe('supervised drafts', () => {
  it('approve flips draft → queued and the outbound worker sends it', async () => {
    const { convo } = await seedConversation();
    const draft = await seedDraft(convo.id, 'Temos horário amanhã às 10h!');

    const res = await api(`/conversations/${convo.id}/drafts/${draft.id}/approve`, {
      method: 'POST',
    });
    expect(res.status).toBe(201);

    await waitFor(async () => (await messageStatus(draft.id)) === 'sent');
    expect(
      fakeWaha.posts.some(
        (p) =>
          p.path === '/api/sendText' &&
          (p.body as { text: string }).text === 'Temos horário amanhã às 10h!',
      ),
    ).toBe(true);
  });

  it('a draft can only be processed once — the second approve loses', async () => {
    const { convo } = await seedConversation();
    const draft = await seedDraft(convo.id, 'rascunho');

    const first = await api(`/conversations/${convo.id}/drafts/${draft.id}/approve`, {
      method: 'POST',
    });
    expect(first.status).toBe(201);
    const second = await api(`/conversations/${convo.id}/drafts/${draft.id}/approve`, {
      method: 'POST',
    });
    expect(second.status).toBe(404);
  });

  it('reject discards the draft (audit row kept) and it never sends', async () => {
    const { convo } = await seedConversation();
    const draft = await seedDraft(convo.id, 'não envie isto');

    const res = await api(`/conversations/${convo.id}/drafts/${draft.id}/reject`, {
      method: 'POST',
    });
    expect(res.status).toBe(201);
    expect(await messageStatus(draft.id)).toBe('discarded');

    await sleep(500);
    expect(fakeWaha.posts.filter((p) => p.path === '/api/sendText')).toHaveLength(0);
  });

  it("drafts belong to their conversation — another conversation's id 404s", async () => {
    const { convo } = await seedConversation();
    const { convo: other } = await seedConversation();
    const draft = await seedDraft(convo.id, 'rascunho');

    const res = await api(`/conversations/${other.id}/drafts/${draft.id}/approve`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });
});

describe('live stream (SSE)', () => {
  it('a pause action reaches an open EventSource as a conversation event', async () => {
    const { convo } = await seedConversation();

    const controller = new AbortController();
    const streamRes = await fetch(`${baseUrl}/api/v1/conversations/stream`, {
      headers: { cookie, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream');

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readLoop = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
      }
    })().catch(() => undefined);

    // Redis SUBSCRIBE settles before the action that must be observed.
    await sleep(300);
    await api(`/conversations/${convo.id}/pause`, { method: 'POST', body: JSON.stringify({}) });

    await waitFor(() => Promise.resolve(buffer.includes('data:')), 10_000);
    controller.abort();
    await readLoop;

    const events = buffer
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice('data: '.length)) as { type: string; conversationId: string });
    expect(events).toContainEqual({ type: 'conversation', conversationId: convo.id });
  }, 30_000);
});

describe('morning digest', () => {
  it('reports overnight conversations, bookings, handoffs and pending drafts', async () => {
    const { convo } = await seedConversation();
    await seedInbound(convo.id, 'mensagem da madrugada');
    await seedDraft(convo.id, 'rascunho pendente');
    await api(`/conversations/${convo.id}/pause`, { method: 'POST', body: JSON.stringify({}) });

    const [service] = await db
      .insert(schema.services)
      .values({ clinicId, name: 'Limpeza de pele', priceCents: 18000, durationMin: 60 })
      .returning();
    const [contactRow] = await sql`select contact_id from conversations where id = ${convo.id}`;
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.insert(schema.appointments).values({
      clinicId,
      contactId: contactRow!.contact_id as string,
      serviceId: service!.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
      status: 'scheduled',
      source: 'agent',
    });

    const res = await api('/conversations/digest');
    expect(res.status).toBe(200);
    const digest = (await res.json()) as {
      activeConversations: unknown[];
      appointmentsBooked: Array<{ serviceName: string; source: string }>;
      pendingHandoffs: unknown[];
      pendingDraftCount: number;
    };
    expect(digest.activeConversations).toHaveLength(1);
    expect(digest.appointmentsBooked).toHaveLength(1);
    expect(digest.appointmentsBooked[0]).toMatchObject({
      serviceName: 'Limpeza de pele',
      source: 'agent',
    });
    expect(digest.pendingHandoffs).toHaveLength(1);
    expect(digest.pendingDraftCount).toBe(1);
  });
});
