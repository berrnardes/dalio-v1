// Webhook door tests — invariant 1's unit-level guarantees: HMAC math,
// noise filtering, layer-1 dedupe, jobId determinism. The full exactly-once
// path (layer 2 + backstop) is covered by the storm integration test.
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type IORedis from 'ioredis';
import type { Queue } from 'bullmq';
import { WebhookIngestService, sanitizeJobId } from '../src/channels/webhook-ingest.service';

const SECRET = 'hmac-test-secret';

function makeService(opts: { secret?: string; nodeEnv?: string; redisSetResult?: 'OK' | null }) {
  // Note: `??` would swallow an explicit null (the "duplicate" simulation).
  const redis = {
    set: vi.fn().mockResolvedValue(opts.redisSetResult === undefined ? 'OK' : opts.redisSetResult),
  };
  const inbound = { add: vi.fn().mockResolvedValue(undefined) };
  const health = { add: vi.fn().mockResolvedValue(undefined) };
  const config = new ConfigService({
    WAHA_WEBHOOK_HMAC_SECRET: opts.secret,
    NODE_ENV: opts.nodeEnv ?? 'test',
  });
  const service = new WebhookIngestService(
    redis as unknown as IORedis,
    inbound as unknown as Queue,
    health as unknown as Queue,
    config,
  );
  return { service, redis, inbound, health };
}

const messageEvent = (overrides: Record<string, unknown> = {}) => ({
  event: 'message',
  session: 'clinic-a',
  payload: {
    id: 'false_5511999998888@c.us_ABC123',
    from: '5511999998888@c.us',
    fromMe: false,
    timestamp: 1_751_000_000,
    body: 'oi',
    ...overrides,
  },
});

const signed = (body: unknown) => {
  const raw = Buffer.from(JSON.stringify(body));
  return { raw, hmac: createHmac('sha512', SECRET).update(raw).digest('hex') };
};

describe('WebhookIngestService', () => {
  it('accepts a valid signed message and enqueues with deterministic jobId', async () => {
    const { service, inbound } = makeService({ secret: SECRET });
    const body = messageEvent();
    const { raw, hmac } = signed(body);

    expect(await service.ingest(raw, hmac, body)).toBe('accepted');
    expect(inbound.add).toHaveBeenCalledOnce();
    const [, job, opts] = inbound.add.mock.calls[0]!;
    expect(job.from).toBe('+5511999998888');
    expect(job.content).toEqual({ kind: 'text', text: 'oi' });
    expect(opts.jobId).toBe(`msg-${sanitizeJobId('false_5511999998888@c.us_ABC123')}`);
  });

  it('rejects a bad HMAC with 401 — never enqueues', async () => {
    const { service, inbound } = makeService({ secret: SECRET });
    const body = messageEvent();
    const { raw } = signed(body);
    await expect(service.ingest(raw, 'f'.repeat(128), body)).rejects.toThrow(/HMAC/);
    expect(inbound.add).not.toHaveBeenCalled();
  });

  it('fails closed in production when no HMAC secret is configured', async () => {
    const { service } = makeService({ secret: undefined, nodeEnv: 'production' });
    await expect(service.ingest(undefined, undefined, messageEvent())).rejects.toThrow(
      /not configured/,
    );
  });

  it('drops layer-1 duplicates as 200/duplicate', async () => {
    const { service, inbound } = makeService({ secret: SECRET, redisSetResult: null });
    const body = messageEvent();
    const { raw, hmac } = signed(body);
    expect(await service.ingest(raw, hmac, body)).toBe('duplicate');
    expect(inbound.add).not.toHaveBeenCalled();
  });

  it.each([
    ['fromMe echo', messageEvent({ fromMe: true })],
    ['group message', messageEvent({ from: '123456@g.us' })],
    ['status broadcast', messageEvent({ from: 'status@broadcast' })],
    ['unknown event', { event: 'message.ack', session: 's', payload: {} }],
    ['garbage envelope', { nope: true }],
  ])('ignores noise at the door: %s', async (_label, body) => {
    const { service, inbound, health } = makeService({ secret: SECRET });
    const { raw, hmac } = signed(body);
    expect(await service.ingest(raw, hmac, body)).toBe('ignored');
    expect(inbound.add).not.toHaveBeenCalled();
    expect(health.add).not.toHaveBeenCalled();
  });

  it('routes session.status to the session-health queue', async () => {
    const { service, health } = makeService({ secret: SECRET });
    const body = { event: 'session.status', session: 'clinic-a', payload: { status: 'FAILED' } };
    const { raw, hmac } = signed(body);
    expect(await service.ingest(raw, hmac, body)).toBe('accepted');
    expect(health.add).toHaveBeenCalledWith('status', {
      provider: 'waha',
      channelExternalId: 'clinic-a',
      status: 'FAILED',
    });
  });

  it('classifies media by mimetype', async () => {
    const { service, inbound } = makeService({ secret: SECRET });
    const body = messageEvent({
      hasMedia: true,
      media: { url: 'http://waha/media/1.oga', mimetype: 'audio/ogg' },
    });
    const { raw, hmac } = signed(body);
    await service.ingest(raw, hmac, body);
    expect(inbound.add.mock.calls[0]![1].content).toEqual({
      kind: 'audio',
      mediaUrl: 'http://waha/media/1.oga',
    });
  });
});

describe('sanitizeJobId', () => {
  it('strips characters BullMQ jobIds cannot carry', () => {
    expect(sanitizeJobId('false_5511@c.us_AB:C')).toBe('false_5511-c-us_AB-C');
  });
});
