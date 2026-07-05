// Agent worker — SPEC §4.4 invariant 3: "one turn in flight per conversation,
// none lost". The lock is more than mutual exclusion: acquiring it is taking
// OWNERSHIP of the conversation until it goes quiet — the drain-loop answers
// messages that arrive mid-turn without a queue round-trip, in order, by the
// same holder. Replaces BullMQ Pro groups with ~40 lines (OSS — SPEC §4.4).
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { QUEUES } from '@dalio/shared';
import type { AgentFlushJob } from '@dalio/shared';
import { RedisScripts } from '../queues/redis-scripts.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { BufferService, bufferKey, bufferStartedKey } from './buffer.service';
import type { TurnHandler } from './turn-handler';
import { TURN_HANDLER } from './turn-handler';

const lockKey = (conversationId: string) => `lock:agent:{${conversationId}}`;

/** Comfortably above the worst expected turn (LLM + tools ≈ 30s), so the TTL
 *  only fires for a genuinely crashed worker — never a slow healthy one. */
const LOCK_TTL_MS = 90_000;
/** Contention retry: the running holder usually drains the buffer first, so
 *  the retry typically finds nothing and exits in O(1). */
const CONTENTION_RETRY_MS = 3_000;
/** Post-release rescue: covers the narrow window where an entry landed after
 *  the final drain but its flush add() was swallowed by the active jobId. */
const RESCUE_DELAY_MS = 250;
/** Hard bound on drain iterations — a pathological message flood must not
 *  pin a worker slot forever; the rescue flush continues the work. */
const MAX_DRAIN_ITERATIONS = 10;

@Processor(QUEUES.AGENT, { concurrency: 10 })
export class AgentWorker extends WorkerHost {
  private readonly logger = new Logger(AgentWorker.name);

  constructor(
    private readonly scripts: RedisScripts,
    private readonly buffer: BufferService,
    private readonly tenantContext: TenantContextService,
    @Inject(TURN_HANDLER) private readonly turnHandler: TurnHandler,
  ) {
    super();
  }

  async process(job: Job<AgentFlushJob>): Promise<void> {
    const { conversationId, clinicId } = job.data;
    const key = lockKey(conversationId);
    const token = randomUUID();

    const acquired = await this.scripts.acquireLock(key, token, LOCK_TTL_MS);
    if (!acquired) {
      // Never block a worker slot waiting on a lock (throughput poison at
      // 500 clinics). Re-enqueue and move on; the holder's drain-loop is
      // probably already consuming what this flush was scheduled for.
      await this.buffer.scheduleRescueFlush(job.data, CONTENTION_RETRY_MS);
      return;
    }

    try {
      for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
        const batch = await this.scripts.drainBuffer(
          bufferKey(conversationId),
          bufferStartedKey(conversationId),
        );
        if (batch.length === 0) break;

        await this.tenantContext.run({ clinicId, userId: 'system:agent' }, () =>
          this.turnHandler.handleTurn({ clinicId, conversationId, messages: batch }),
        );

        // Ownership check between iterations: if the TTL expired mid-turn
        // another worker may already hold the lock — continuing would
        // overlap turns, the exact bug this worker exists to prevent.
        const stillOwner = await this.scripts.extendLock(key, token, LOCK_TTL_MS);
        if (!stillOwner) {
          this.logger.error(
            `Lost agent lock mid-drain for conversation ${conversationId} — stopping`,
          );
          return;
        }
      }
    } finally {
      await this.scripts.releaseLock(key, token);
    }

    // Stranded-buffer rescue (see BufferService.scheduleFlush race note).
    if ((await this.buffer.length(conversationId)) > 0) {
      await this.buffer.scheduleRescueFlush(job.data, RESCUE_DELAY_MS);
    }
  }
}
