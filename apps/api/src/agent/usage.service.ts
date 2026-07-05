// Per-tenant LLM metering — SPEC §3 usage_counters, DOCUMENTO-EXECUTIVO §5:
// "uma clínica tagarela não pode comer a margem". Monthly rollup per clinic;
// budget alerts read from here (Phase 7 wires the alerting).
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { usageCounters } from '../db/schema';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';

@Injectable()
export class UsageService extends TenantScopedRepository {
  async recordLlm(tokensIn: number, tokensOut: number, costCents: number): Promise<void> {
    const month = new Date().toISOString().slice(0, 7);
    await this.db
      .insert(usageCounters)
      .values({
        clinicId: this.clinicId,
        month,
        llmTokensIn: tokensIn,
        llmTokensOut: tokensOut,
        llmCostCents: costCents,
      })
      .onConflictDoUpdate({
        target: [usageCounters.clinicId, usageCounters.month],
        set: {
          llmTokensIn: sql`${usageCounters.llmTokensIn} + ${tokensIn}`,
          llmTokensOut: sql`${usageCounters.llmTokensOut} + ${tokensOut}`,
          llmCostCents: sql`${usageCounters.llmCostCents} + ${costCents}`,
        },
      });
  }
}
