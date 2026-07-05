// Inbox event bus — SPEC §7: real-time transport behind the SSE endpoint.
//
// Redis pub/sub (not in-process EventEmitter) so the fan-out survives running
// multiple api instances: the worker that persists an inbound message and the
// instance holding a clinic's SSE socket need not be the same process.
// Pub/sub delivery is fire-and-forget by design — a missed event costs one
// refetch on the next event or page load, never data (Postgres is the truth).
//
// Payloads are InboxEvent id-pointers only (see packages/shared/src/inbox.ts):
// message content must not transit the event bus (iron rule #7).
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type IORedis from 'ioredis';
import type { InboxEvent } from '@dalio/shared';
import { REDIS } from '../queues/redis.token';

/** One Redis channel per clinic keeps subscriber-side filtering trivial. */
const channelFor = (clinicId: string) => `inbox:events:${clinicId}`;

type Listener = (event: InboxEvent) => void;

@Injectable()
export class InboxEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboxEventsService.name);

  /**
   * ioredis connections in subscriber mode reject regular commands, so the
   * shared REDIS client publishes and this dedicated duplicate subscribes.
   */
  private subscriber!: IORedis;

  /** Local listeners per clinic; Redis SUBSCRIBE is held while non-empty. */
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(@Inject(REDIS) private readonly redis: IORedis) {}

  onModuleInit(): void {
    this.subscriber = this.redis.duplicate();
    // Without a listener ioredis surfaces transient socket errors as
    // "Unhandled error event" noise; it reconnects on its own either way.
    this.subscriber.on('error', (err) => {
      this.logger.warn(`inbox subscriber redis error: ${String(err)}`);
    });
    this.subscriber.on('message', (channel: string, raw: string) => {
      const clinicId = channel.slice('inbox:events:'.length);
      const set = this.listeners.get(clinicId);
      if (!set || set.size === 0) return;
      let event: InboxEvent;
      try {
        event = JSON.parse(raw) as InboxEvent;
      } catch {
        return; // malformed event: drop — clients heal on the next refetch
      }
      for (const listener of set) listener(event);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit().catch(() => undefined);
  }

  /**
   * Publish a change notification for a clinic's inbox. Callers pass the
   * clinicId explicitly (workers publish outside a request scope). Failures
   * are logged, never thrown: notifying the dashboard must not fail the
   * pipeline job that did the real work.
   */
  async publish(clinicId: string, event: InboxEvent): Promise<void> {
    try {
      await this.redis.publish(channelFor(clinicId), JSON.stringify(event));
    } catch (err) {
      this.logger.warn(`inbox event publish failed for clinic ${clinicId}: ${String(err)}`);
    }
  }

  /**
   * Subscribe an SSE socket to a clinic's events. Returns the unsubscribe
   * cleanup — the controller MUST call it on socket close or listeners (and
   * eventually Redis subscriptions) leak with every reconnect.
   */
  async subscribe(clinicId: string, listener: Listener): Promise<() => Promise<void>> {
    let set = this.listeners.get(clinicId);
    if (!set) {
      set = new Set();
      this.listeners.set(clinicId, set);
      await this.subscriber.subscribe(channelFor(clinicId));
    }
    set.add(listener);

    return async () => {
      const current = this.listeners.get(clinicId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(clinicId);
        await this.subscriber.unsubscribe(channelFor(clinicId)).catch(() => undefined);
      }
    };
  }
}
