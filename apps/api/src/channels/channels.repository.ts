// Channel resolution — the ONE deliberately non-tenant-scoped repository.
// It cannot extend TenantScopedRepository because it IS the tenant resolver:
// inbound events arrive with only (provider, externalId) and this lookup is
// what establishes which clinic owns them (SPEC §4.1). Every other domain
// repository must stay tenant-scoped (iron rule #1).
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Provider } from '@dalio/shared';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { channels, clinics } from '../db/schema';

export interface ResolvedChannel {
  id: string;
  clinicId: string;
  provider: Provider;
  externalId: string;
  host: string | null;
  ratePolicy: typeof channels.$inferSelect.ratePolicy;
  clinicStatus: 'active' | 'suspended';
  clinicSettings: typeof clinics.$inferSelect.settings;
  clinicTimezone: string;
}

@Injectable()
export class ChannelsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findByExternalId(
    provider: Provider,
    externalId: string,
  ): Promise<ResolvedChannel | null> {
    const [row] = await this.db
      .select({
        id: channels.id,
        clinicId: channels.clinicId,
        provider: channels.provider,
        externalId: channels.externalId,
        host: channels.host,
        ratePolicy: channels.ratePolicy,
        clinicStatus: clinics.status,
        clinicSettings: clinics.settings,
        clinicTimezone: clinics.timezone,
      })
      .from(channels)
      .innerJoin(clinics, eq(clinics.id, channels.clinicId))
      .where(and(eq(channels.provider, provider), eq(channels.externalId, externalId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * A connected channel id for a clinic, or null. Used by proactive senders
   * (reminders, waitlist backfill — Phase 4) that hold a clinicId but no
   * channel: a clinic with no connected number simply can't be reached, and
   * the caller skips rather than failing.
   */
  async findConnectedChannelId(clinicId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.clinicId, clinicId), eq(channels.status, 'connected')))
      .limit(1);
    return row?.id ?? null;
  }

  /** Status transitions come exclusively from the session-health worker. */
  async updateStatusByExternalId(
    provider: Provider,
    externalId: string,
    status: 'provisioning' | 'pairing' | 'connected' | 'disconnected' | 'failed',
  ): Promise<void> {
    await this.db
      .update(channels)
      .set({ status })
      .where(and(eq(channels.provider, provider), eq(channels.externalId, externalId)));
  }
}
