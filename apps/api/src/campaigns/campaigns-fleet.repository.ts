// Fleet-wide campaign operations — Phase 6. The FOURTH deliberately
// non-tenant repository (with Channels/RemindersScan/Numbers), and the
// narrowest: cross-clinic scanning for the dispatcher tick and the canary
// kill-switch. Per-clinic campaign work stays in the tenant-scoped
// CampaignsRepository — anything needing more than "which campaigns run"
// belongs there.
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { campaigns } from '../db/schema';

export type CampaignRow = typeof campaigns.$inferSelect;

@Injectable()
export class CampaignsFleetRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Dispatcher tick input: every running campaign across all clinics. */
  async listRunning(): Promise<CampaignRow[]> {
    return this.db.select().from(campaigns).where(eq(campaigns.status, 'running'));
  }

  /**
   * Canary kill-switch: a suspected detection wave stops ALL reactivation
   * traffic at once — per-clinic ceremony would take exactly the hours the
   * wave needs. Returns how many were paused (for the alarm log).
   */
  async pauseAllRunning(): Promise<number> {
    const rows = await this.db
      .update(campaigns)
      .set({ status: 'paused' })
      .where(eq(campaigns.status, 'running'))
      .returning({ id: campaigns.id });
    return rows.length;
  }
}
