// Reactivation segment builder — DOCUMENTO-EXECUTIVO §3.4 (Phase 6):
// "recorrência por serviço, não blast genérico". A contact enters the segment
// because a SPECIFIC service's return interval has lapsed since their last
// completed visit — which also gives the copy its hook ("já faz X semanas do
// seu {{servico}}"). Suppression is classified here, in one query, and
// RECORDED — the clinic sees why someone was skipped, never a silent hole.
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  ACTIVE_CONVERSATION_DAYS,
  RECENT_CONTACT_DAYS,
  SUPPRESSION_REASONS,
} from '@dalio/shared';
import type { SegmentRules } from '@dalio/shared';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';

export interface SegmentMember {
  contactId: string;
  contactName: string | null;
  serviceId: string;
  serviceName: string;
  lastVisitAt: Date;
  overdueDays: number;
  /** Null = eligible to receive; otherwise why they must not be messaged. */
  suppressedReason: string | null;
}

@Injectable()
export class SegmentBuilder extends TenantScopedRepository {
  /**
   * Builds the segment for the given rules. One row per (contact, service)
   * pair whose return interval has lapsed; when a contact is overdue on
   * several services, the MOST overdue one wins (one nudge per person —
   * multiple would look exactly like the spam it must not be).
   *
   * Suppression precedence: opt-out (LGPD, absolute) → future appointment →
   * active conversation → recent contact.
   */
  async build(rules: SegmentRules | null): Promise<SegmentMember[]> {
    // Integer inputs are validated then inlined via sql.raw — our postgres.js
    // mis-serializes non-string params on raw templates (CLAUDE.md gotcha),
    // and intervals can't be bound as bare params anyway.
    const overdueMin = intOrDefault(rules?.overdueDaysMin, 0);
    const overdueMax = intOrDefault(rules?.overdueDaysMax, 365);
    const serviceFilter =
      rules?.serviceIds && rules.serviceIds.length > 0
        ? sql`and a.service_id = any(${`{${rules.serviceIds.join(',')}}`}::uuid[])`
        : sql``;

    const rows = await this.db.execute(sql`
      with last_visit as (
        select a.contact_id, a.service_id, max(a.starts_at) as last_at
        from appointments a
        join services s on s.id = a.service_id
        where a.clinic_id = ${this.clinicId}
          and a.status = 'completed'
          and s.return_interval_days is not null
          ${serviceFilter}
        group by a.contact_id, a.service_id
      ),
      overdue as (
        select
          lv.contact_id, lv.service_id, lv.last_at,
          s.name as service_name,
          floor(extract(epoch from now() - (lv.last_at + make_interval(days => s.return_interval_days))) / 86400)::int as overdue_days,
          row_number() over (
            partition by lv.contact_id
            order by extract(epoch from now() - (lv.last_at + make_interval(days => s.return_interval_days))) desc
          ) as rank
        from last_visit lv
        join services s on s.id = lv.service_id
      )
      select
        o.contact_id, o.service_id, o.service_name, o.last_at, o.overdue_days,
        c.name as contact_name,
        case
          when c.opt_out_at is not null then ${SUPPRESSION_REASONS.OPTED_OUT}
          when exists (
            select 1 from appointments f
            where f.clinic_id = ${this.clinicId} and f.contact_id = o.contact_id
              and f.status in ('scheduled', 'confirmed') and f.starts_at > now()
          ) then ${SUPPRESSION_REASONS.FUTURE_APPOINTMENT}
          when exists (
            select 1 from conversations cv
            where cv.clinic_id = ${this.clinicId} and cv.contact_id = o.contact_id
              and (
                cv.last_inbound_at > now() - make_interval(days => ${sql.raw(String(ACTIVE_CONVERSATION_DAYS))})
                or cv.paused_until > now()
              )
          ) then ${SUPPRESSION_REASONS.ACTIVE_CONVERSATION}
          when exists (
            select 1 from conversations cv
            where cv.clinic_id = ${this.clinicId} and cv.contact_id = o.contact_id
              and cv.last_outbound_at > now() - make_interval(days => ${sql.raw(String(RECENT_CONTACT_DAYS))})
          ) then ${SUPPRESSION_REASONS.RECENT_CONTACT}
          else null
        end as suppressed_reason
      from overdue o
      join contacts c on c.id = o.contact_id
      where o.rank = 1
        and o.overdue_days between ${sql.raw(String(overdueMin))} and ${sql.raw(String(overdueMax))}
      order by o.overdue_days desc
    `);

    return (rows as Array<Record<string, unknown>>).map((r) => ({
      contactId: r.contact_id as string,
      contactName: (r.contact_name as string | null) ?? null,
      serviceId: r.service_id as string,
      serviceName: r.service_name as string,
      lastVisitAt: new Date(r.last_at as string),
      overdueDays: r.overdue_days as number,
      suppressedReason: (r.suppressed_reason as string | null) ?? null,
    }));
  }

  /**
   * Send-time re-suppression for ONE contact — same rules and precedence as
   * build(), minus the overdue math (segment membership was decided at
   * start; whether we may still message them is decided now).
   */
  async classifyContact(contactId: string): Promise<string | null> {
    const rows = await this.db.execute(sql`
      select case
        when c.opt_out_at is not null then ${SUPPRESSION_REASONS.OPTED_OUT}
        when exists (
          select 1 from appointments f
          where f.clinic_id = ${this.clinicId} and f.contact_id = c.id
            and f.status in ('scheduled', 'confirmed') and f.starts_at > now()
        ) then ${SUPPRESSION_REASONS.FUTURE_APPOINTMENT}
        when exists (
          select 1 from conversations cv
          where cv.clinic_id = ${this.clinicId} and cv.contact_id = c.id
            and (
              cv.last_inbound_at > now() - make_interval(days => ${sql.raw(String(ACTIVE_CONVERSATION_DAYS))})
              or cv.paused_until > now()
            )
        ) then ${SUPPRESSION_REASONS.ACTIVE_CONVERSATION}
        else null
      end as reason
      from contacts c
      where c.clinic_id = ${this.clinicId} and c.id = ${contactId}
    `);
    const row = (rows as Array<Record<string, unknown>>)[0];
    // RECENT_CONTACT is deliberately NOT re-checked here: the campaign's own
    // earlier sends update last_outbound_at and would suppress the rest of
    // the drip. The snapshot already filtered pre-campaign recency.
    return (row?.reason as string | null) ?? null;
  }

  /** Name material for the template variables of one recipient. */
  async describe(
    contactId: string,
    serviceId: string | null,
  ): Promise<{ contactName: string | null; serviceName: string | null }> {
    const rows = await this.db.execute(sql`
      select c.name as contact_name, s.name as service_name
      from contacts c
      left join services s on s.id = ${serviceId}::uuid
      where c.clinic_id = ${this.clinicId} and c.id = ${contactId}
    `);
    const row = (rows as Array<Record<string, unknown>>)[0];
    return {
      contactName: (row?.contact_name as string | null) ?? null,
      serviceName: (row?.service_name as string | null) ?? null,
    };
  }
}

function intOrDefault(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) ? (value as number) : fallback;
}
