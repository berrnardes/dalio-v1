import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  clinicId: string;
  userId: string;
}

/**
 * Iron rule #1 carrier: the current clinic travels via AsyncLocalStorage,
 * set by TenantMiddleware for HTTP requests (queue workers will set it
 * explicitly from the job payload in Phase 1).
 */
@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantContext>();

  run<T>(ctx: TenantContext, fn: () => T): T {
    return this.als.run(ctx, fn);
  }

  get(): TenantContext | undefined {
    return this.als.getStore();
  }

  requireClinicId(): string {
    const store = this.als.getStore();
    if (!store) {
      throw new Error(
        'No tenant context. Data access outside TenantMiddleware/worker scope is a bug.',
      );
    }
    return store.clinicId;
  }
}
