// Storm tests — the Phase 1 merge gate (SPEC §8): the three pipeline
// invariants exercised end-to-end (HTTP webhook → dedupe → buffer → lock →
// turn) against real Postgres and Redis in containers, with randomized
// arrival jitter. This ~200-line pipeline is where a subtle bug costs
// customers invisibly (DOCUMENTO-EXECUTIVO §3.1) — hence the density here.
import { createHmac, randomUUID } from 'node:crypto';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import IORedis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { WahaApiClient } from '../../src/channels/providers/waha-api.client';
import { TURN_HANDLER } from '../../src/conversations/turn-handler';
import type { TurnInput } from '../../src/conversations/turn-handler';

const HMAC_SECRET = 'storm-hmac-secret';
/** Short debounce so bursts coalesce in test-time, not human-time. */
const DEBOUNCE_MS = 250;

// ── Test doubles ──────────────────────────────────────────────────────────

/** Records turns and proves serialization: activeTurns must never exceed 1
 *  for a single conversation (invariant 3's core assertion). */
class RecordingTurnHandler {
  turns: TurnInput[] = [];
  active = new Map<string, number>();
  maxConcurrentPerConvo = 0;
  turnDurationMs = 0;

  async handleTurn(input: TurnInput): Promise<void> {
    const current = (this.active.get(input.conversationId) ?? 0) + 1;
    this.active.set(input.conversationId, current);
    this.maxConcurrentPerConvo = Math.max(this.maxConcurrentPerConvo, current);
    if (this.turnDurationMs > 0) {
      await new Promise((r) => setTimeout(r, this.turnDurationMs));
    }
    this.turns.push(input);
    this.active.set(input.conversationId, current - 1);
  }

  totalMessages(): number {
    return this.turns.reduce((sum, t) => sum + t.messages.length, 0);
  }

  reset(): void {
    this.turns = [];
    this.active.clear();
    this.maxConcurrentPerConvo = 0;
    this.turnDurationMs = 0;
  }
}

/** WAHA network stub — typing indicators land here instead of HTTP. */
class FakeWahaApi {
  posts: Array<{ path: string }> = [];
  post(path: string): Promise<unknown> {
    this.posts.push({ path });
    return Promise.resolve({ id: `fake-${randomUUID()}` });
  }
}

// ── Harness ───────────────────────────────────────────────────────────────

let pgContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let baseUrl: string;
let sql: postgres.Sql;
let redis: IORedis;
let clinicId: string;
const recorder = new RecordingTurnHandler();
const fakeWaha = new FakeWahaApi();

beforeAll(async () => {
  [pgContainer, redisContainer] = await Promise.all([
    new GenericContainer('postgres:17-alpine')
      .withEnvironment({ POSTGRES_USER: 'storm', POSTGRES_PASSWORD: 'storm', POSTGRES_DB: 'storm' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/ready to accept connections/, 2))
      .start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);

  const dbUrl = `postgres://storm:storm@localhost:${pgContainer.getMappedPort(5432)}/storm`;
  const redisUrl = `redis://localhost:${redisContainer.getMappedPort(6379)}`;

  // Runtime env wins over .env files in @nestjs/config — safe locally and in CI.
  process.env.DATABASE_URL = dbUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.BETTER_AUTH_SECRET = 'storm-secret-with-at-least-32-characters!';
  process.env.BETTER_AUTH_URL = 'http://localhost:3000';
  process.env.WAHA_WEBHOOK_HMAC_SECRET = HMAC_SECRET;
  process.env.NODE_ENV = 'test';

  sql = postgres(dbUrl, { max: 2 });
  await migrate(drizzle(sql, { schema }), { migrationsFolder: 'drizzle' });
  redis = new IORedis(redisUrl);

  // Seed: one clinic with a fast debounce, one connected WAHA channel.
  const db = drizzle(sql, { schema });
  const [clinic] = await db
    .insert(schema.clinics)
    .values({ name: 'Storm Clinic', slug: 'storm', settings: { debounceMs: DEBOUNCE_MS } })
    .returning();
  clinicId = clinic!.id;
  await db.insert(schema.channels).values({
    clinicId,
    provider: 'waha',
    externalId: 'storm-session',
    status: 'connected',
  });

  const { AppModule } = await import('../../src/app.module');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TURN_HANDLER)
    .useValue(recorder)
    .overrideProvider(WahaApiClient)
    .useValue(fakeWaha)
    .compile();

  // Same bootstrap options as main.ts: the auth module owns body parsing
  // (rawBody for HMAC verification).
  app = moduleRef.createNestApplication({ bodyParser: false });
  app.enableShutdownHooks();
  // A real listening socket: 10+ parallel webhook posts over supertest's
  // per-request ephemeral servers cause ECONNRESETs; fetch against one
  // listener is the production shape anyway.
  await app.listen(0);
  baseUrl = await app.getUrl();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await redis?.quit();
  await sql?.end({ timeout: 5 });
  await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
}, 60_000);

afterEach(async () => {
  // Settle then wipe between scenarios: queues, buffers, dedupe keys, rows.
  await waitForQuiet();
  await redis.flushall();
  await sql`truncate messages, conversations, contacts cascade`;
  recorder.reset();
  fakeWaha.posts = [];
});

let seq = 0;
function webhookBody(text: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    event: 'message',
    session: 'storm-session',
    payload: {
      id: `false_5511999998888@c.us_${seq}_${randomUUID().slice(0, 8)}`,
      from: '5511999998888@c.us',
      fromMe: false,
      timestamp: Math.floor(Date.now() / 1000),
      body: text,
      ...overrides,
    },
  };
}

async function post(body: unknown): Promise<string> {
  const raw = JSON.stringify(body);
  const hmac = createHmac('sha512', HMAC_SECRET).update(raw).digest('hex');
  const res = await fetch(`${baseUrl}/webhooks/waha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-hmac': hmac },
    body: raw,
  });
  expect(res.status).toBe(200);
  return (body as { payload: { id: string } }).payload.id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error('waitFor timed out');
}

/** Quiet = no active turn, empty buffer, no pending flush work. */
async function waitForQuiet(): Promise<void> {
  await waitFor(async () => {
    const buffers = await redis.keys('buffer:*');
    const active = [...recorder.active.values()].some((n) => n > 0);
    return buffers.length === 0 && !active;
  }, 30_000).catch(() => undefined);
}

async function messageCount(): Promise<number> {
  const [row] = await sql`select count(*)::int as n from messages where direction = 'inbound'`;
  return row!.n as number;
}

// ── The three invariants ──────────────────────────────────────────────────

describe('invariant 1 — durably captured exactly once', () => {
  it('a redelivered webhook produces one message row and one buffered turn message', async () => {
    const body = webhookBody('mensagem repetida');
    await post(body);
    await post(body); // WAHA redelivery
    await post(body); // and again

    await waitFor(() => recorder.totalMessages() >= 1);
    await sleep(600); // give a would-be duplicate time to surface

    expect(await messageCount()).toBe(1);
    expect(recorder.totalMessages()).toBe(1);
  }, 60_000);
});

describe('invariant 2 — one turn per burst', () => {
  it('coalesces a typing burst into a single turn, in order', async () => {
    await post(webhookBody('oi'));
    await sleep(80);
    await post(webhookBody('vcs fazem limpeza de pele?'));
    await sleep(80);
    await post(webhookBody('e quanto custa'));

    await waitFor(() => recorder.totalMessages() >= 3);
    await sleep(600);

    expect(recorder.turns.length).toBe(1);
    expect(recorder.turns[0]!.messages.map((m) => m.text)).toEqual([
      'oi',
      'vcs fazem limpeza de pele?',
      'e quanto custa',
    ]);
    // Typing indicator fired exactly once for the burst.
    expect(fakeWaha.posts.filter((p) => p.path === '/api/startTyping').length).toBe(1);
  }, 60_000);
});

describe('invariant 3 — one turn in flight, none lost', () => {
  it('messages arriving mid-turn are answered by the drain-loop, never concurrently', async () => {
    recorder.turnDurationMs = 700; // turn slower than the debounce window

    await post(webhookBody('primeira'));
    await waitFor(() => recorder.active.size > 0 || recorder.turns.length > 0);
    // Land two more while the first turn is (or was just) running.
    await post(webhookBody('segunda'));
    await sleep(60);
    await post(webhookBody('terceira'));

    await waitFor(() => recorder.totalMessages() >= 3, 30_000);
    expect(recorder.maxConcurrentPerConvo).toBe(1);
    const all = recorder.turns.flatMap((t) => t.messages.map((m) => m.text));
    expect(all.sort()).toEqual(['primeira', 'segunda', 'terceira']);
  }, 60_000);

  it('survives a 30-message storm in waves: none lost, never overlapping', async () => {
    // Three waves with jittered arrivals inside each wave and inter-wave
    // gaps wider than debounce+turn — deterministic multi-turn contention.
    // (A single continuous stream with gaps under the debounce correctly
    // coalesces into ONE turn; that's invariant 2, tested above.)
    recorder.turnDurationMs = 150;
    const waves = 3;
    const perWave = 10;
    const texts: string[] = [];

    for (let w = 0; w < waves; w++) {
      const waveTexts = Array.from({ length: perWave }, (_, i) => `storm-${w}-${i}`);
      texts.push(...waveTexts);
      await Promise.all(
        waveTexts.map(async (text) => {
          await sleep(Math.floor(Math.random() * 400));
          await post(webhookBody(text));
        }),
      );
      await sleep(900); // > debounce (250) + turn (150): the wave must flush
    }

    const N = waves * perWave;
    await waitFor(() => recorder.totalMessages() >= N, 60_000);
    await sleep(1_000); // rescue-flush window — nothing extra may appear
    expect(recorder.totalMessages()).toBe(N);
    expect(recorder.maxConcurrentPerConvo).toBe(1);
    expect(await messageCount()).toBe(N);

    const delivered = recorder.turns.flatMap((t) => t.messages.map((m) => m.text));
    expect([...delivered].sort()).toEqual([...texts].sort());
    // Waves guarantee real serialization work: at least one turn per wave.
    expect(recorder.turns.length).toBeGreaterThanOrEqual(waves);
  }, 120_000);
});
