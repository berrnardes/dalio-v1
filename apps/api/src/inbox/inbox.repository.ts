// Inbox read models — SPEC §7 (Inbox) and the Phase 3 morning digest.
//
// The inbox is the clinic's ONLY human channel (the WhatsApp number is the
// company's — DOCUMENTO-EXECUTIVO: no clinic-side fromMe exists), so these
// queries are the dashboard's backbone: what's happening, what needs a human,
// what did the agent do overnight. Tenant-scoped like every repository
// (iron rule #1).
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import type { ConversationStatus, DeliveryStatus, MessageKind, MessageSource } from '@dalio/shared';
import { appointments, contacts, conversations, messages, services } from '../db/schema';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';

/** One inbox list row: enough to render the conversation card without N+1s. */
export interface ConversationListItem {
  id: string;
  status: ConversationStatus;
  contactId: string;
  contactName: string | null;
  contactPhone: string;
  optedOut: boolean;
  pausedUntil: Date | null;
  pausedByUserId: string | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  lastMessage: {
    id: string;
    direction: 'inbound' | 'outbound';
    source: MessageSource;
    kind: MessageKind;
    status: DeliveryStatus;
    preview: string;
    createdAt: Date;
  } | null;
  /** Drafts awaiting approval — the supervised-mode attention badge. */
  pendingDrafts: number;
}

export interface MorningDigest {
  since: Date;
  /** Conversations with inbound activity in the window (the night shift). */
  activeConversations: Array<{
    conversationId: string;
    contactName: string | null;
    contactPhone: string;
    lastInboundAt: Date | null;
    pausedUntil: Date | null;
  }>;
  /** Appointments the agent (or anyone) booked in the window. */
  appointmentsBooked: Array<{
    appointmentId: string;
    contactName: string | null;
    contactPhone: string;
    serviceName: string;
    startsAt: Date;
    source: string;
  }>;
  /** Threads a human owns right now (handoff or takeover) — the to-do list. */
  pendingHandoffs: Array<{
    conversationId: string;
    contactName: string | null;
    contactPhone: string;
    pausedUntil: Date;
    pausedByUserId: string | null;
  }>;
  /** Supervised-mode drafts waiting for approval. */
  pendingDraftCount: number;
}

@Injectable()
export class InboxRepository extends TenantScopedRepository {
  /**
   * Conversation cards ordered by most recent contact activity. Three fixed
   * queries (conversations+contact, last message per conversation via
   * DISTINCT ON, draft counts) instead of a per-row N+1.
   */
  async listConversations(status: ConversationStatus, limit = 100): Promise<ConversationListItem[]> {
    const rows = await this.db
      .select({
        id: conversations.id,
        status: conversations.status,
        pausedUntil: conversations.pausedUntil,
        pausedByUserId: conversations.pausedByUserId,
        lastInboundAt: conversations.lastInboundAt,
        lastOutboundAt: conversations.lastOutboundAt,
        contactId: contacts.id,
        contactName: contacts.name,
        contactPhone: contacts.phone,
        optOutAt: contacts.optOutAt,
      })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(and(eq(conversations.clinicId, this.clinicId), eq(conversations.status, status)))
      .orderBy(sql`${conversations.lastInboundAt} DESC NULLS LAST`)
      .limit(limit);

    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    // Newest message per conversation: DISTINCT ON over the uuidv7 id.
    const lastMessages = await this.db
      .selectDistinctOn([messages.conversationId])
      .from(messages)
      .where(and(eq(messages.clinicId, this.clinicId), inArray(messages.conversationId, ids)))
      .orderBy(messages.conversationId, desc(messages.id));
    const lastByConvo = new Map(lastMessages.map((m) => [m.conversationId, m]));

    const draftCounts = await this.db
      .select({ conversationId: messages.conversationId, drafts: count() })
      .from(messages)
      .where(
        and(
          eq(messages.clinicId, this.clinicId),
          inArray(messages.conversationId, ids),
          eq(messages.status, 'draft'),
        ),
      )
      .groupBy(messages.conversationId);
    const draftsByConvo = new Map(draftCounts.map((d) => [d.conversationId, Number(d.drafts)]));

    return rows.map((r) => {
      const last = lastByConvo.get(r.id);
      return {
        id: r.id,
        status: r.status,
        contactId: r.contactId,
        contactName: r.contactName,
        contactPhone: r.contactPhone,
        optedOut: r.optOutAt !== null,
        pausedUntil: r.pausedUntil,
        pausedByUserId: r.pausedByUserId,
        lastInboundAt: r.lastInboundAt,
        lastOutboundAt: r.lastOutboundAt,
        lastMessage: last
          ? {
              id: last.id,
              direction: last.direction,
              source: last.source,
              kind: last.kind,
              status: last.status,
              preview: previewOf(last),
              createdAt: last.createdAt,
            }
          : null,
        pendingDrafts: draftsByConvo.get(r.id) ?? 0,
      };
    });
  }

  /**
   * The morning digest — SPEC §5's out-of-hours handoff promise ("a human
   * follows up in the morning") needs a surface listing exactly what the
   * night produced. Computed on demand; nothing is stored.
   */
  async digest(since: Date): Promise<MorningDigest> {
    const now = new Date();

    const activeConversations = await this.db
      .select({
        conversationId: conversations.id,
        contactName: contacts.name,
        contactPhone: contacts.phone,
        lastInboundAt: conversations.lastInboundAt,
        pausedUntil: conversations.pausedUntil,
      })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(and(eq(conversations.clinicId, this.clinicId), gte(conversations.lastInboundAt, since)))
      .orderBy(desc(conversations.lastInboundAt))
      .limit(100);

    const appointmentsBooked = await this.db
      .select({
        appointmentId: appointments.id,
        contactName: contacts.name,
        contactPhone: contacts.phone,
        serviceName: services.name,
        startsAt: appointments.startsAt,
        source: appointments.source,
      })
      .from(appointments)
      .innerJoin(contacts, eq(contacts.id, appointments.contactId))
      .innerJoin(services, eq(services.id, appointments.serviceId))
      .where(and(eq(appointments.clinicId, this.clinicId), gte(appointments.createdAt, since)))
      .orderBy(desc(appointments.createdAt))
      .limit(100);

    const pendingHandoffRows = await this.db
      .select({
        conversationId: conversations.id,
        contactName: contacts.name,
        contactPhone: contacts.phone,
        pausedUntil: conversations.pausedUntil,
        pausedByUserId: conversations.pausedByUserId,
      })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(
        and(
          eq(conversations.clinicId, this.clinicId),
          eq(conversations.status, 'open'),
          gt(conversations.pausedUntil, now),
        ),
      )
      .orderBy(desc(conversations.pausedUntil))
      .limit(100);

    const [draftRow] = await this.db
      .select({ drafts: count() })
      .from(messages)
      .where(and(eq(messages.clinicId, this.clinicId), eq(messages.status, 'draft')));

    return {
      since,
      activeConversations,
      appointmentsBooked,
      // pausedUntil is non-null by the gt() filter; narrow for the consumer.
      pendingHandoffs: pendingHandoffRows.map((r) => ({ ...r, pausedUntil: r.pausedUntil! })),
      pendingDraftCount: Number(draftRow?.drafts ?? 0),
    };
  }
}

/** Human-readable one-liner for the conversation card. Content here flows
 *  over the authenticated REST API only — never into logs or events. */
function previewOf(m: {
  kind: MessageKind;
  body: { text?: string; caption?: string };
  transcription: string | null;
  intent: { kind: string; text?: string; prompt?: string } | null;
}): string {
  const text =
    m.body.text ??
    m.transcription ??
    m.body.caption ??
    // Outbound drafts/queued rows have body={} until send; render the intent.
    (m.intent?.kind === 'text' ? m.intent.text : m.intent?.kind === 'choice' ? m.intent.prompt : undefined);
  if (text) return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  switch (m.kind) {
    case 'audio':
      return '[áudio]';
    case 'image':
      return '[imagem]';
    case 'document':
      return '[documento]';
    default:
      return '[mensagem]';
  }
}
