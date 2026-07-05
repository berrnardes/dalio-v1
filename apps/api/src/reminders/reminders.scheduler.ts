// Reminder tick scheduler — SPEC §4 (Phase 4). Registers ONE repeatable
// BullMQ job that fires every 60s onto the reminders-scan queue; the worker
// re-reads the due set each tick (see RemindersScanWorker). upsertJobScheduler
// is idempotent by key, so booting N api instances yields ONE ticker, not N.
import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUES } from '@dalio/shared';

/** 60s: reminders are hour/day-scale; a finer tick just adds Redis chatter. */
const SCAN_INTERVAL_MS = 60_000;
const SCHEDULER_KEY = 'reminders-scan-tick';

@Injectable()
export class RemindersScheduler implements OnModuleInit {
  private readonly logger = new Logger(RemindersScheduler.name);

  constructor(@InjectQueue(QUEUES.REMINDERS_SCAN) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SCHEDULER_KEY,
      { every: SCAN_INTERVAL_MS },
      {
        name: 'scan',
        // The tick carries no state; keep the queue clean so a backlog can't
        // build from the heartbeat itself.
        opts: { removeOnComplete: true, removeOnFail: { count: 20 } },
      },
    );
    this.logger.log(`Reminder scanner scheduled every ${SCAN_INTERVAL_MS / 1000}s`);
  }
}
