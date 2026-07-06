// Health — SPEC §8 (Phase 7): the load balancer's yes/no AND the operator's
// first look. Reports the four things that actually page us: Postgres,
// Redis, WhatsApp sessions (connected vs expected — a clinic with a dead
// session is unreachable revenue), and queue backpressure (waiting count +
// oldest-job age; a growing oldest-age with steady waiting means workers
// stalled — SPEC §8's enqueue→processing lag gauge).
import { Controller, Get, Inject } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { getQueueToken } from '@nestjs/bullmq';
import { ModuleRef } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import type IORedis from 'ioredis';
import { QUEUES } from '@dalio/shared';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { REDIS } from '../queues/queues.module';

/** The queues whose backlog means users are waiting (not periodic tickers). */
const WATCHED_QUEUES = [QUEUES.INBOUND, QUEUES.AGENT, QUEUES.OUTBOUND] as const;

@AllowAnonymous()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: IORedis,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Get()
  async check() {
    const [db, redis, channels, queues] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.checkChannels(),
      this.checkQueues(),
    ]);
    // Channels degrade the status but a clinic-less fresh install is still ok.
    const ok = db && redis && channels.expected === channels.connected;
    return {
      status: db && redis ? (ok ? 'ok' : 'degraded') : 'down',
      db,
      redis,
      channels,
      queues,
    };
  }

  private async checkDb(): Promise<boolean> {
    try {
      await this.db.execute(sql`select 1`);
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /** connected vs expected: every non-provisioning channel of an active
   *  clinic should be connected; the gap is the incident list. */
  private async checkChannels(): Promise<{ expected: number; connected: number }> {
    try {
      const rows = await this.db.execute(sql`
        select
          count(*) filter (where ch.status <> 'provisioning')::int as expected,
          count(*) filter (where ch.status = 'connected')::int as connected
        from channels ch
        join clinics c on c.id = ch.clinic_id and c.status = 'active'
      `);
      const row = rows[0] as { expected: number; connected: number } | undefined;
      return row ?? { expected: 0, connected: 0 };
    } catch {
      return { expected: -1, connected: -1 };
    }
  }

  private async checkQueues() {
    const out: Record<string, { waiting: number; oldestWaitMs: number | null }> = {};
    for (const name of WATCHED_QUEUES) {
      try {
        const queue = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
        const [waiting, oldest] = await Promise.all([
          queue.getWaitingCount(),
          queue.getJobs(['waiting'], 0, 0, true),
        ]);
        out[name] = {
          waiting,
          oldestWaitMs: oldest[0]?.timestamp ? Date.now() - oldest[0].timestamp : null,
        };
      } catch {
        out[name] = { waiting: -1, oldestWaitMs: null };
      }
    }
    return out;
  }
}
