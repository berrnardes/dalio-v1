// Webhook ingestion — SPEC §4.4 invariant 1: "durably captured exactly once".
// The whole job: authenticate (HMAC), filter noise at the door, dedupe, and
// get the event into Redis in single-digit milliseconds. NO Postgres here —
// ingestion must stay up during a DB incident, with messages queuing instead
// of vanishing. Anything unprocessable is ACKed (200) and logged: returning
// 5xx makes WAHA redeliver garbage forever.
import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { QUEUES } from '@dalio/shared';
import type { InboundContent, InboundJob, SessionHealthJob } from '@dalio/shared';
import { REDIS } from '../queues/queues.module';

export type IngestOutcome = 'accepted' | 'duplicate' | 'ignored';

/**
 * Minimal envelope check only — deep payload validation happens in the
 * worker. The handler must not spend time (or trust) on more than routing.
 */
const wahaEnvelope = z.object({
  event: z.string(),
  session: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

const wahaMessagePayload = z.object({
  id: z.string(),
  from: z.string(),
  fromMe: z.boolean().optional(),
  timestamp: z.number().optional(),
  body: z.string().optional(),
  hasMedia: z.boolean().optional(),
  media: z
    .object({ url: z.string().optional(), mimetype: z.string().optional() })
    .nullish(),
});

const wahaSessionStatusPayload = z.object({ status: z.string() });

const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class WebhookIngestService {
  private readonly logger = new Logger(WebhookIngestService.name);
  private readonly hmacSecret?: string;
  private readonly isProduction: boolean;

  constructor(
    @Inject(REDIS) private readonly redis: IORedis,
    @InjectQueue(QUEUES.INBOUND) private readonly inboundQueue: Queue,
    @InjectQueue(QUEUES.SESSION_HEALTH) private readonly sessionHealthQueue: Queue,
    config: ConfigService,
  ) {
    this.hmacSecret = config.get<string>('WAHA_WEBHOOK_HMAC_SECRET');
    this.isProduction = config.get<string>('NODE_ENV') === 'production';
  }

  async ingest(
    rawBody: Buffer | undefined,
    hmacHeader: string | undefined,
    body: unknown,
  ): Promise<IngestOutcome> {
    this.verifyHmac(rawBody, hmacHeader);

    const envelope = wahaEnvelope.safeParse(body);
    if (!envelope.success) {
      this.logger.warn(`Unparseable webhook envelope: ${envelope.error.message}`);
      return 'ignored';
    }
    const { event, session, payload } = envelope.data;

    if (event === 'session.status') return this.ingestSessionStatus(session, payload);
    if (event === 'message') return this.ingestMessage(session, payload);

    // Acks, presence etc. are 10-50x message volume — they never reach a
    // queue that feeds the LLM. Subscribe narrowly in WAHA config too.
    return 'ignored';
  }

  private async ingestMessage(
    session: string,
    payload: Record<string, unknown>,
  ): Promise<IngestOutcome> {
    const parsed = wahaMessagePayload.safeParse(payload);
    if (!parsed.success) {
      this.logger.warn(`Unparseable message payload: ${parsed.error.message}`);
      return 'ignored';
    }
    const msg = parsed.data;

    // fromMe echoes are our own API sends bouncing back (company SIM — no
    // human uses this number's app); groups and broadcasts are out of scope.
    if (msg.fromMe) return 'ignored';
    if (msg.from.endsWith('@g.us') || msg.from === 'status@broadcast') return 'ignored';

    // Dedupe layer 1: fast pre-filter. Racy alone (SET could land and the
    // enqueue crash before completing) — layer 2's deterministic jobId is
    // the real guarantee, atomic with enqueueing.
    const fresh = await this.redis.set(
      `dedupe:${msg.id}`,
      '1',
      'PX',
      DEDUPE_TTL_MS,
      'NX',
    );
    if (!fresh) return 'duplicate';

    const job: InboundJob = {
      provider: 'waha',
      channelExternalId: session,
      providerMessageId: msg.id,
      from: `+${msg.from.replace(/@.*$/, '').replace(/\D/g, '')}`,
      timestamp: (msg.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
      content: this.toContent(msg),
    };

    // Dedupe layer 2: BullMQ silently ignores an add with an existing jobId,
    // so a redelivery that slipped past layer 1 still produces one job.
    await this.inboundQueue.add('inbound', job, { jobId: `msg-${sanitizeJobId(msg.id)}` });
    return 'accepted';
  }

  private async ingestSessionStatus(
    session: string,
    payload: Record<string, unknown>,
  ): Promise<IngestOutcome> {
    const parsed = wahaSessionStatusPayload.safeParse(payload);
    if (!parsed.success) return 'ignored';

    const job: SessionHealthJob = {
      provider: 'waha',
      channelExternalId: session,
      status: parsed.data.status,
    };
    await this.sessionHealthQueue.add('status', job);
    return 'accepted';
  }

  /**
   * WAHA signs the raw body with HMAC-SHA512. Verification must use the raw
   * bytes (re-serializing parsed JSON is not byte-stable). Missing secret is
   * tolerated in dev only — production fails closed.
   */
  private verifyHmac(rawBody: Buffer | undefined, hmacHeader: string | undefined): void {
    if (!this.hmacSecret) {
      if (this.isProduction) {
        throw new UnauthorizedException('Webhook HMAC secret not configured');
      }
      return; // dev convenience: WAHA without HMAC configured
    }
    if (!rawBody || !hmacHeader) throw new UnauthorizedException('Missing webhook HMAC');

    const expected = createHmac('sha512', this.hmacSecret).update(rawBody).digest('hex');
    const provided = Buffer.from(hmacHeader, 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
      throw new UnauthorizedException('Invalid webhook HMAC');
    }
  }

  private toContent(msg: z.infer<typeof wahaMessagePayload>): InboundContent {
    if (msg.hasMedia && msg.media?.url) {
      const mime = msg.media.mimetype ?? '';
      if (mime.startsWith('audio/')) return { kind: 'audio', mediaUrl: msg.media.url };
      if (mime.startsWith('image/')) {
        return { kind: 'image', mediaUrl: msg.media.url, caption: msg.body || undefined };
      }
      return { kind: 'document', mediaUrl: msg.media.url, caption: msg.body || undefined };
    }
    return { kind: 'text', text: msg.body ?? '' };
  }
}

/** BullMQ jobIds cannot contain ':' (Redis key separator); WAHA ids can. */
export function sanitizeJobId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '-');
}
