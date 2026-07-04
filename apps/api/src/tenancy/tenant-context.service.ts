import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  clinicId: string;
  userId: string;
}

type TenantStore = Partial<TenantContext>;

/**
 * Iron rule #1 carrier. HTTP: TenantContextMiddleware opens an empty store
 * around the request and TenantGuard fills it via set() after AuthGuard
 * resolves the session. (A guard cannot open the store itself: enterWith()
 * inside an awaited guard does not survive the guard's return — the store
 * object must be created by middleware wrapping next().)
 * Workers (Phase 1) wrap job handlers with run() using the job's clinicId.
 */
@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantStore>();

  /** Opens a store for the given scope — queue workers and tests. */
  run<T>(ctx: TenantContext, fn: () => T): T {
    return this.als.run({ ...ctx }, fn);
  }

  /** Opens an empty store — TenantContextMiddleware only. */
  runEmpty<T>(fn: () => T): T {
    return this.als.run({}, fn);
  }

  /** Fills the current store — TenantGuard only. */
  set(ctx: TenantContext): void {
    const store = this.als.getStore();
    if (!store) {
      throw new Error('No tenant store open. TenantContextMiddleware must run first.');
    }
    Object.assign(store, ctx);
  }

  get(): TenantContext | undefined {
    const store = this.als.getStore();
    return store?.clinicId && store?.userId ? (store as TenantContext) : undefined;
  }

  requireClinicId(): string {
    const store = this.als.getStore();
    if (!store?.clinicId) {
      throw new Error('No tenant context. Data access outside a tenant scope is a bug.');
    }
    return store.clinicId;
  }
}
