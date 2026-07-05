// Debounce buffer — SPEC §4.4 invariant 2: "one agent turn per burst".
// Humans send "oi" / "vcs fazem limpeza?" / "quanto custa" as three messages
// in seconds; without coalescing, each would trigger its own LLM turn and
// the contact gets three overlapping replies. Entries land in a Redis list;
// a delayed AGENT job is the sliding flush timer.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { QUEUES } from '@dalio/shared';
import type { AgentFlushJob, BufferedMessage } from '@dalio/shared';
import { REDIS } from '../queues/queues.module';

export const bufferKey = (conversationId: string) => `buffer:{${conversationId}}`;
export const bufferStartedKey = (conversationId: string) => `buffer-started:{${conversationId}}`;
export const flushJobId = (conversationId: string) => `flush-${conversationId}`;

/** Default debounce; per-clinic override via clinics.settings.debounceMs. */
export const DEFAULT_DEBOUNCE_MS = 7_000;
/**
 * Sliding-window cap: a continuous typer must still get an answer. After
 * 25s from the first buffered message the flush fires regardless; later
 * messages start a new turn (handled by the drain-loop or the next flush).
 */
export const MAX_WINDOW_MS = 25_000;
/** Safety TTL — an orphaned buffer (crashed flush chain) self-cleans. */
const BUFFER_TTL_MS = 300_000;

@Injectable()
export class BufferService {
  private readonly logger = new Logger(BufferService.name);

  constructor(
    @Inject(REDIS) private readonly redis: IORedis,
    @InjectQueue(QUEUES.AGENT) private readonly agentQueue: Queue<AgentFlushJob>,
  ) {}

  /**
   * Appends a message to the conversation's burst and (re)schedules the
   * flush. Returns the buffer length so the caller can trigger the typing
   * indicator exactly once per burst (length === 1).
   */
  async push(params: {
    conversationId: string;
    clinicId: string;
    entry: BufferedMessage;
    debounceMs?: number;
    /** Structured replies (pending choice) skip the wait — SPEC §4.4. */
    skipDebounce?: boolean;
  }): Promise<number> {
    const bKey = bufferKey(params.conversationId);
    const sKey = bufferStartedKey(params.conversationId);
    const now = Date.now();

    const [[, length]] = (await this.redis
      .multi()
      .rpush(bKey, JSON.stringify(params.entry))
      .set(sKey, String(now), 'PX', BUFFER_TTL_MS, 'NX')
      .pexpire(bKey, BUFFER_TTL_MS)
      .exec()) as [[unknown, number], ...unknown[][]];

    await this.scheduleFlush(params, now, sKey);
    return length;
  }

  /**
   * Sliding window: every new message replaces the pending flush with a
   * fresh one, so the timer restarts while the contact is still typing —
   * capped by MAX_WINDOW_MS from the burst's first message.
   *
   * Known race, handled elsewhere by design: if the flush job is already
   * RUNNING, remove() fails and add() is a no-op (same jobId). The running
   * turn's drain-loop picks the new entry up before releasing the lock, and
   * the post-release stranded-buffer check (agent worker) covers the tiny
   * window after the final drain. Invariant: a message is consumed exactly
   * once — NOT "exactly one flush per burst".
   */
  private async scheduleFlush(
    params: { conversationId: string; clinicId: string; debounceMs?: number; skipDebounce?: boolean },
    now: number,
    startedKey: string,
  ): Promise<void> {
    const debounce = params.skipDebounce ? 0 : (params.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    const startedRaw = await this.redis.get(startedKey);
    const started = startedRaw ? Number(startedRaw) : now;
    const capRemaining = Math.max(0, started + MAX_WINDOW_MS - now);
    const delay = Math.min(debounce, capRemaining);

    const jobId = flushJobId(params.conversationId);
    const existing = await this.agentQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState().catch(() => 'unknown');
      if (state === 'delayed' || state === 'waiting') {
        // May still fail if it just started — benign, see the race note.
        await existing.remove().catch(() => undefined);
      }
    }

    await this.agentQueue
      .add('flush', { conversationId: params.conversationId, clinicId: params.clinicId }, { jobId, delay })
      .catch((err) => {
        // add() with an existing (active) jobId throws in some BullMQ
        // versions instead of no-oping — same benign race.
        this.logger.debug(`flush add skipped for ${params.conversationId}: ${String(err)}`);
      });
  }

  /** Used by the agent worker's post-release safety check. */
  async length(conversationId: string): Promise<number> {
    return this.redis.llen(bufferKey(conversationId));
  }

  /** Re-enqueue with a UNIQUE jobId — contention retries and stranded-buffer rescues. */
  async scheduleRescueFlush(job: AgentFlushJob, delayMs: number): Promise<void> {
    await this.agentQueue.add('flush', job, {
      jobId: `${flushJobId(job.conversationId)}-r${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      delay: delayMs,
    });
  }
}
