// Warm-up ticker — DOCUMENTO-EXECUTIVO §3.3 (Phase 6). One repeatable job
// (idempotent by key across N instances) advancing warming numbers along the
// ramp. Hourly, not daily: quota derives from warmupStartedAt AGE, so ticks
// are convergent and a finer interval only means a fresher quota after boots
// and deploys — never double-advancement.
import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUES } from '@dalio/shared';
import { NumbersService } from './numbers.service';

const TICK_INTERVAL_MS = 60 * 60 * 1000;
const SCHEDULER_KEY = 'number-warmup-tick';

@Injectable()
export class WarmupScheduler implements OnModuleInit {
  private readonly logger = new Logger(WarmupScheduler.name);

  constructor(@InjectQueue(QUEUES.NUMBER_WARMUP) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SCHEDULER_KEY,
      { every: TICK_INTERVAL_MS },
      { name: 'tick', opts: { removeOnComplete: true, removeOnFail: { count: 20 } } },
    );
    this.logger.log(`Number warm-up tick scheduled every ${TICK_INTERVAL_MS / 60000}min`);
  }
}

@Processor(QUEUES.NUMBER_WARMUP)
export class WarmupWorker extends WorkerHost {
  constructor(private readonly numbers: NumbersService) {
    super();
  }

  async process(): Promise<void> {
    await this.numbers.warmupTick();
  }
}
