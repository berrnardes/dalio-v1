// Metrics aggregations — SPEC §7 (Phase 5): the SQL behind the four hero
// metrics. Computed on-read from the domain tables (no counters that drift);
// every query filters by the ALS clinic (iron rule #1). Money stays in
// integer cents end to end.
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';

/** UTC instants of the clinic-local month: [start, end). */
export interface MonthRange {
  start: Date;
  end: Date;
}

/** A lead-initiated conversation's opening timestamps (see leadConversations). */
export interface LeadConversation {
  conversationId: string;
  contactId: string;
  firstInboundAt: Date;
  /** Null when the lead was never answered — those count against the median's denominator honesty, so we track them. */
  firstReplyAt: Date | null;
}

@Injectable()
export class MetricsRepository extends TenantScopedRepository {
  /**
   * Hero metric #1 — autonomous bookings: appointments the agent created in
   * the month, valued at the service's price. Cancelled/no-show ones are
   * excluded: the dashboard claims captured revenue, not attempted revenue.
   */
  async agentBookings(range: MonthRange): Promise<{ count: number; cents: number }> {
    const rows = await this.db.execute(sql`
      select count(*)::int as count, coalesce(sum(s.price_cents), 0)::int as cents
      from appointments a
      join services s on s.id = a.service_id
      where a.clinic_id = ${this.clinicId}
        and a.source = 'agent'
        and a.created_at >= ${range.start.toISOString()}::timestamptz and a.created_at < ${range.end.toISOString()}::timestamptz
        and a.status not in ('cancelled', 'no_show')
    `);
    return rows[0] as { count: number; cents: number };
  }

  /**
   * Hero metric #2 raw material — appointments in the month that were
   * confirmed AFTER a confirmation reminder went out (the anti-no-show
   * cadence visibly working). The service layer multiplies the cents by the
   * clinic's baseline no-show rate to produce the R$ *estimate*.
   * Scoped by startsAt (the chair defended sits in this month), and requires
   * a SENT confirm-kind reminder — a manually confirmed appointment isn't
   * the engine's win.
   */
  async confirmedAfterReminder(range: MonthRange): Promise<{ count: number; cents: number }> {
    const rows = await this.db.execute(sql`
      select count(*)::int as count, coalesce(sum(s.price_cents), 0)::int as cents
      from appointments a
      join services s on s.id = a.service_id
      where a.clinic_id = ${this.clinicId}
        and a.status in ('confirmed', 'completed')
        and a.starts_at >= ${range.start.toISOString()}::timestamptz and a.starts_at < ${range.end.toISOString()}::timestamptz
        and exists (
          select 1 from reminders r
          where r.appointment_id = a.id
            and r.kind in ('confirm_24h', 'at_risk_2h')
            and r.sent_at is not null
        )
    `);
    return rows[0] as { count: number; cents: number };
  }

  /**
   * Lead-initiated conversations whose first inbound landed in the month,
   * with their first-response timestamps. "Lead-initiated" = the inbound is
   * the conversation's very first message — threads WE opened (reminders,
   * campaigns) would fake a 0s response time and are excluded. First reply =
   * first outbound that actually left (sent/delivered/read; drafts and
   * queue-stuck rows don't count as answering anyone).
   *
   * Returns rows instead of aggregates: the out-of-hours classification needs
   * per-timestamp wall-clock math against jsonb workingHours, which is far
   * saner in TS than in SQL — and a clinic's monthly lead count is small.
   */
  async leadConversations(range: MonthRange): Promise<LeadConversation[]> {
    const rows = await this.db.execute(sql`
      with firsts as (
        select
          m.conversation_id,
          min(m.created_at) as first_any,
          min(m.created_at) filter (where m.direction = 'inbound') as first_in,
          min(m.created_at) filter (
            where m.direction = 'outbound' and m.status in ('sent', 'delivered', 'read')
          ) as first_out
        from messages m
        where m.clinic_id = ${this.clinicId}
        group by m.conversation_id
      )
      select f.conversation_id, c.contact_id, f.first_in, f.first_out
      from firsts f
      join conversations c on c.id = f.conversation_id
      where f.first_in is not null
        and f.first_in = f.first_any
        and f.first_in >= ${range.start.toISOString()}::timestamptz and f.first_in < ${range.end.toISOString()}::timestamptz
    `);
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      conversationId: r.conversation_id as string,
      contactId: r.contact_id as string,
      firstInboundAt: new Date(r.first_in as string),
      firstReplyAt: r.first_out ? new Date(r.first_out as string) : null,
    }));
  }

  /**
   * Conversion leg of hero metric #4: agent bookings in the month made by the
   * given contacts (the ones whose lead arrived out of hours). Valued like
   * agentBookings — captured, not attempted.
   */
  async agentBookingsForContacts(
    range: MonthRange,
    contactIds: string[],
  ): Promise<{ count: number; cents: number }> {
    if (contactIds.length === 0) return { count: 0, cents: 0 };
    // Drizzle's sql template flattens JS arrays into scalar params — build the
    // Postgres array literal ourselves. Safe: ids come from our own uuid rows,
    // and ::uuid[] rejects anything that isn't one.
    const idsLiteral = `{${contactIds.join(',')}}`;
    const rows = await this.db.execute(sql`
      select count(*)::int as count, coalesce(sum(s.price_cents), 0)::int as cents
      from appointments a
      join services s on s.id = a.service_id
      where a.clinic_id = ${this.clinicId}
        and a.source = 'agent'
        and a.contact_id = any(${idsLiteral}::uuid[])
        and a.created_at >= ${range.start.toISOString()}::timestamptz and a.created_at < ${range.end.toISOString()}::timestamptz
        and a.status not in ('cancelled', 'no_show')
    `);
    return rows[0] as { count: number; cents: number };
  }
}
