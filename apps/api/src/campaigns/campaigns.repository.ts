// Campaign persistence — DOCUMENTO-EXECUTIVO §3.4 (Phase 6, reactivation).
// Tenant-scoped: campaigns, their recipient snapshots, and the attribution
// writes (replied/converted). The fleet-wide reads live in
// CampaignsFleetRepository; the segment SQL lives in SegmentBuilder.
import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { ATTRIBUTION_WINDOW_DAYS } from '@dalio/shared';
import type { SegmentRules } from '@dalio/shared';
import { campaignRecipients, campaigns } from '../db/schema';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';

export type CampaignRow = typeof campaigns.$inferSelect;
export type RecipientRow = typeof campaignRecipients.$inferSelect;

@Injectable()
export class CampaignsRepository extends TenantScopedRepository {
  async list(): Promise<CampaignRow[]> {
    return this.db
      .select()
      .from(campaigns)
      .where(eq(campaigns.clinicId, this.clinicId))
      .orderBy(asc(campaigns.id));
  }

  async getById(id: string): Promise<CampaignRow | undefined> {
    const [row] = await this.db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.clinicId, this.clinicId), eq(campaigns.id, id)))
      .limit(1);
    return row;
  }

  async create(values: {
    name: string;
    templateKey: string;
    segment: SegmentRules | null;
    dailyCap: number;
  }): Promise<CampaignRow> {
    const [row] = await this.db
      .insert(campaigns)
      .values({ clinicId: this.clinicId, kind: 'reactivation', status: 'draft', ...values })
      .returning();
    return row!;
  }

  /** Status flip guarded by the expected current status (no draft→done leaps). */
  async setStatus(
    id: string,
    from: CampaignRow['status'],
    to: CampaignRow['status'],
    extra: Partial<typeof campaigns.$inferInsert> = {},
  ): Promise<CampaignRow | undefined> {
    const [row] = await this.db
      .update(campaigns)
      .set({ status: to, ...extra })
      .where(
        and(eq(campaigns.clinicId, this.clinicId), eq(campaigns.id, id), eq(campaigns.status, from)),
      )
      .returning();
    return row;
  }

  // ── Recipients (the start-time snapshot the drip walks through) ──────────

  async insertRecipients(
    rows: Array<{
      campaignId: string;
      contactId: string;
      serviceId: string | null;
      suppressedReason: string | null;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insert(campaignRecipients)
      .values(rows.map((r) => ({ clinicId: this.clinicId, ...r })));
  }

  /** The next unsent, unsuppressed recipient — the drip's cursor (uuidv7 order). */
  async nextPending(campaignId: string): Promise<RecipientRow | undefined> {
    const [row] = await this.db
      .select()
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.clinicId, this.clinicId),
          eq(campaignRecipients.campaignId, campaignId),
          isNull(campaignRecipients.sentAt),
          isNull(campaignRecipients.suppressedReason),
        ),
      )
      .orderBy(asc(campaignRecipients.id))
      .limit(1);
    return row;
  }

  /** Sends since `since` — the daily-cap check uses clinic-local midnight. */
  async countSentSince(campaignId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.clinicId, this.clinicId),
          eq(campaignRecipients.campaignId, campaignId),
          sql`${campaignRecipients.sentAt} >= ${since.toISOString()}::timestamptz`,
        ),
      );
    return row?.n ?? 0;
  }

  /** Most recent send — the drip-interval check. */
  async lastSentAt(campaignId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: sql<string | null>`max(${campaignRecipients.sentAt})` })
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.clinicId, this.clinicId),
          eq(campaignRecipients.campaignId, campaignId),
        ),
      );
    return row?.at ? new Date(row.at) : null;
  }

  async markSent(recipientId: string): Promise<void> {
    await this.db
      .update(campaignRecipients)
      .set({ sentAt: new Date() })
      .where(
        and(eq(campaignRecipients.clinicId, this.clinicId), eq(campaignRecipients.id, recipientId)),
      );
  }

  /** Late suppression: the snapshot said send, the re-check at send time said no. */
  async markSuppressed(recipientId: string, reason: string): Promise<void> {
    await this.db
      .update(campaignRecipients)
      .set({ suppressedReason: reason })
      .where(
        and(eq(campaignRecipients.clinicId, this.clinicId), eq(campaignRecipients.id, recipientId)),
      );
  }

  /** True when nothing remains to send — the campaign can close. */
  async hasPending(campaignId: string): Promise<boolean> {
    return (await this.nextPending(campaignId)) !== undefined;
  }

  // ── Attribution (metrics: campaign → replies → appointments) ─────────────

  /** Marks the contact's fresh campaign sends as replied (first reply wins). */
  async recordReply(contactId: string, now: Date = new Date()): Promise<void> {
    const windowStart = new Date(now.getTime() - ATTRIBUTION_WINDOW_DAYS * 86_400_000);
    await this.db
      .update(campaignRecipients)
      .set({ repliedAt: now })
      .where(
        and(
          eq(campaignRecipients.clinicId, this.clinicId),
          eq(campaignRecipients.contactId, contactId),
          isNull(campaignRecipients.repliedAt),
          sql`${campaignRecipients.sentAt} >= ${windowStart.toISOString()}::timestamptz`,
        ),
      );
  }

  /**
   * Links a fresh booking back to the campaign send that plausibly caused it
   * (sent within the attribution window, not yet converted). First unconverted
   * send wins — one appointment never counts for two campaigns.
   */
  async recordConversion(
    contactId: string,
    appointmentId: string,
    now: Date = new Date(),
  ): Promise<void> {
    const windowStart = new Date(now.getTime() - ATTRIBUTION_WINDOW_DAYS * 86_400_000);
    await this.db.execute(sql`
      update campaign_recipients set converted_appointment_id = ${appointmentId}
      where id = (
        select id from campaign_recipients
        where clinic_id = ${this.clinicId}
          and contact_id = ${contactId}
          and converted_appointment_id is null
          and sent_at >= ${windowStart.toISOString()}::timestamptz
        order by sent_at asc limit 1
      )
    `);
  }
}
