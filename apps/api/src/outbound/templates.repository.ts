// Template lookup — iron rule #2: campaigns/reminders reference templateKey,
// never raw copy. Clinic-specific templates override globals (clinicId null).
import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { templates } from '../db/schema';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';

export type TemplateRow = typeof templates.$inferSelect;

@Injectable()
export class TemplatesRepository extends TenantScopedRepository {
  async findByKey(key: string): Promise<TemplateRow | null> {
    const [clinicOwned] = await this.db
      .select()
      .from(templates)
      .where(and(eq(templates.clinicId, this.clinicId), eq(templates.key, key)))
      .limit(1);
    if (clinicOwned) return clinicOwned;

    const [global] = await this.db
      .select()
      .from(templates)
      .where(and(isNull(templates.clinicId), eq(templates.key, key)))
      .limit(1);
    return global ?? null;
  }
}
