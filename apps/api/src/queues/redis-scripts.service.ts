// Atomic Redis operations backing the three pipeline invariants — SPEC §4.4.
// Each script exists because the multi-step equivalent has a race that
// breaks an invariant; the comments on each script name the race.
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type IORedis from 'ioredis';
import type { BufferedMessage } from '@dalio/shared';
import { REDIS } from './redis.token';

/**
 * GET+DEL is racy: a slow worker could delete a lock the *next* holder
 * acquired after this one's TTL expired, letting two turns overlap
 * (invariant 3). Compare-and-delete makes release conditional on ownership.
 */
const RELEASE_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

/** Same ownership rule for TTL extension between drain-loop iterations. */
const EXTEND_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

/**
 * LRANGE+DEL as two calls would let a message RPUSHed in between be deleted
 * without ever being read — a silently lost message (invariant 3: "none
 * lost"). Draining atomically guarantees every buffered entry is consumed
 * exactly once. KEYS[2] (buffer_started, the sliding-window cap marker)
 * resets with the buffer so the next burst starts a fresh window.
 */
const DRAIN_BUFFER = `
local items = redis.call('lrange', KEYS[1], 0, -1)
redis.call('del', KEYS[1])
redis.call('del', KEYS[2])
return items
`;

@Injectable()
export class RedisScripts implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: IORedis) {
    // defineCommand caches the script server-side (EVALSHA) once per client.
    this.redis.defineCommand('dalioReleaseLock', { numberOfKeys: 1, lua: RELEASE_LOCK });
    this.redis.defineCommand('dalioExtendLock', { numberOfKeys: 1, lua: EXTEND_LOCK });
    this.redis.defineCommand('dalioDrainBuffer', { numberOfKeys: 2, lua: DRAIN_BUFFER });
  }

  /** SET NX PX — returns true when this caller now owns the lock. */
  async acquireLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async releaseLock(key: string, token: string): Promise<void> {
    await (this.redis as RedisWithScripts).dalioReleaseLock(key, token);
  }

  /** Returns false when ownership was lost (TTL expired mid-turn) — caller must stop. */
  async extendLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await (this.redis as RedisWithScripts).dalioExtendLock(key, token, ttlMs);
    return result === 1;
  }

  async drainBuffer(bufferKey: string, startedKey: string): Promise<BufferedMessage[]> {
    const raw = await (this.redis as RedisWithScripts).dalioDrainBuffer(bufferKey, startedKey);
    return raw.map((item) => JSON.parse(item) as BufferedMessage);
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }
}

type RedisWithScripts = IORedis & {
  dalioReleaseLock(key: string, token: string): Promise<number>;
  dalioExtendLock(key: string, token: string, ttlMs: number): Promise<number>;
  dalioDrainBuffer(bufferKey: string, startedKey: string): Promise<string[]>;
};
