import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { services } from '../db/schema';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';

export interface CreateServiceInput {
  name: string;
  priceCents: number;
  durationMin: number;
  returnIntervalDays?: number;
}

@Injectable()
export class ServicesRepository extends TenantScopedRepository {
  list() {
    return this.db
      .select()
      .from(services)
      .where(and(eq(services.clinicId, this.clinicId), eq(services.active, true)));
  }

  async getById(id: string) {
    const [row] = await this.db
      .select()
      .from(services)
      .where(and(eq(services.clinicId, this.clinicId), eq(services.id, id)))
      .limit(1);
    return row ?? null;
  }

  async create(input: CreateServiceInput) {
    const [row] = await this.db
      .insert(services)
      .values({ ...input, clinicId: this.clinicId })
      .returning();
    return row;
  }
}
