// Current-clinic accessor — SPEC §3. The agent prompt (persona, catalog,
// hours) and the availability engine both read the clinic row; tenant-scoped
// so "current" always means the ALS clinic (iron rule #1).
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { clinics } from '../db/schema';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';

export type ClinicRow = typeof clinics.$inferSelect;

@Injectable()
export class ClinicsRepository extends TenantScopedRepository {
  async getCurrent(): Promise<ClinicRow> {
    const [row] = await this.db
      .select()
      .from(clinics)
      .where(eq(clinics.id, this.clinicId))
      .limit(1);
    if (!row) throw new Error('Tenant context points at a missing clinic');
    return row;
  }
}
