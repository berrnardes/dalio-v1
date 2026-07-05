// Queue infrastructure — SPEC §4.3. Registers the BullMQ root connection and
// all Phase 1 queues, and exposes a shared ioredis client (REDIS) for the
// pipeline's non-queue Redis state: dedupe keys, conversation buffers, locks.
import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { QUEUES } from '@dalio/shared';
import { RedisScripts } from './redis-scripts.service';

export const REDIS = Symbol('REDIS');

const queueRegistrations = Object.values(QUEUES).map((name) =>
  BullModule.registerQueue({
    name,
    defaultJobOptions: {
      // Transient infra errors retry with backoff; a job that fails 5 times
      // parks in the failed set (24h) for inspection — never silently lost.
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 3_600, count: 5_000 },
      removeOnFail: { age: 86_400 },
    },
  }),
);

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        // maxRetriesPerRequest: null is a BullMQ worker requirement — workers
        // block on Redis streams and must not have ioredis abort those calls.
        connection: new IORedis(config.getOrThrow<string>('REDIS_URL'), {
          maxRetriesPerRequest: null,
        }),
      }),
      inject: [ConfigService],
    }),
    ...queueRegistrations,
  ],
  providers: [
    {
      provide: REDIS,
      useFactory: (config: ConfigService) =>
        new IORedis(config.getOrThrow<string>('REDIS_URL'), { maxRetriesPerRequest: null }),
      inject: [ConfigService],
    },
    RedisScripts,
  ],
  exports: [REDIS, RedisScripts, ...queueRegistrations],
})
export class QueuesModule {}
