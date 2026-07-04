import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { TenantContextService } from './tenant-context.service';

/**
 * Base for all domain repositories (iron rule #1). Subclasses read
 * `this.clinicId` — which throws outside a tenant scope — and must filter
 * every query by it. Services/controllers never touch Drizzle directly.
 */
@Injectable()
export abstract class TenantScopedRepository {
  constructor(
    @Inject(DB) protected readonly db: Db,
    protected readonly tenant: TenantContextService,
  ) {}

  protected get clinicId(): string {
    return this.tenant.requireClinicId();
  }
}
