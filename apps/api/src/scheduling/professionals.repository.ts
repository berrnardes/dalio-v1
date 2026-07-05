// Professionals — SPEC §3. Active professionals define the clinic's parallel
// capacity in the availability engine (N chairs = N overlapping appointments).
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { professionals } from '../db/schema';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';

export type ProfessionalRow = typeof professionals.$inferSelect;

@Injectable()
export class ProfessionalsRepository extends TenantScopedRepository {
  listActive(): Promise<ProfessionalRow[]> {
    return this.db
      .select()
      .from(professionals)
      .where(and(eq(professionals.clinicId, this.clinicId), eq(professionals.active, true)));
  }

  async create(name: string): Promise<ProfessionalRow> {
    const [row] = await this.db
      .insert(professionals)
      .values({ clinicId: this.clinicId, name })
      .returning();
    return row!;
  }
}
