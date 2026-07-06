// Current-clinic accessor — SPEC §3. The agent prompt (persona, catalog,
// hours) and the availability engine both read the clinic row; tenant-scoped
// so "current" always means the ALS clinic (iron rule #1).
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { ClinicSettings } from '@dalio/shared';
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

  /** Shallow-merges a settings patch (jsonb ||) — concurrent editors of
   *  DIFFERENT keys never clobber each other. */
  async patchSettings(patch: Partial<ClinicSettings>): Promise<ClinicRow> {
    const [row] = await this.db
      .update(clinics)
      .set({
        settings: sql`coalesce(${clinics.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      })
      .where(eq(clinics.id, this.clinicId))
      .returning();
    return row!;
  }

  /** Activation flip (Phase 7) — only the onboarding gate calls this. */
  async setStatus(status: 'active' | 'suspended'): Promise<void> {
    await this.db.update(clinics).set({ status }).where(eq(clinics.id, this.clinicId));
  }
}
