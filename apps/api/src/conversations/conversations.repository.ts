// Conversations + messages persistence for the pipeline. Tenant-scoped
// (iron rule #1); workers open the tenant scope from the job payload.
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, notInArray } from 'drizzle-orm';
import type { InboundContent, MessageKind } from '@dalio/shared';
import { conversations, messages } from '../db/schema';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

@Injectable()
export class ConversationsRepository extends TenantScopedRepository {
  /**
   * One open conversation per (contact, channel) — enforced by the partial
   * unique index conversations_open_unique. On insert conflict (concurrent
   * worker won the race) we re-select the winner instead of failing the job.
   */
  async findOrCreateOpen(contactId: string, channelId: string): Promise<ConversationRow> {
    const existing = await this.findOpen(contactId, channelId);
    if (existing) return existing;

    const [inserted] = await this.db
      .insert(conversations)
      .values({ clinicId: this.clinicId, contactId, channelId })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;

    const winner = await this.findOpen(contactId, channelId);
    if (!winner) throw new Error('findOrCreateOpen race lost twice');
    return winner;
  }

  private async findOpen(contactId: string, channelId: string): Promise<ConversationRow | null> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.clinicId, this.clinicId),
          eq(conversations.contactId, contactId),
          eq(conversations.channelId, channelId),
          eq(conversations.status, 'open'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async getById(id: string): Promise<ConversationRow | null> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.clinicId, this.clinicId), eq(conversations.id, id)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Conversation history for the agent's context window, oldest-first.
   * `excludeIds` drops the current burst (already persisted by the inbound
   * worker) so it isn't duplicated as both history and the new user turn.
   */
  async listRecentMessages(
    conversationId: string,
    excludeIds: string[],
    limit = 20,
  ): Promise<MessageRow[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.clinicId, this.clinicId),
          eq(messages.conversationId, conversationId),
          excludeIds.length > 0 ? notInArray(messages.id, excludeIds) : undefined,
        ),
      )
      .orderBy(desc(messages.id)) // uuidv7 = time-ordered
      .limit(limit);
    return rows.reverse();
  }

  /** Human takeover / handoff: the agent stays silent until `until` passes. */
  async pause(conversationId: string, until: Date, byUserId: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ pausedUntil: until, pausedByUserId: byUserId })
      .where(and(eq(conversations.clinicId, this.clinicId), eq(conversations.id, conversationId)));
  }

  async touchLastInbound(conversationId: string, at: Date): Promise<void> {
    await this.db
      .update(conversations)
      .set({ lastInboundAt: at })
      .where(and(eq(conversations.clinicId, this.clinicId), eq(conversations.id, conversationId)));
  }

  async touchLastOutbound(conversationId: string, at: Date): Promise<void> {
    await this.db
      .update(conversations)
      .set({ lastOutboundAt: at })
      .where(and(eq(conversations.clinicId, this.clinicId), eq(conversations.id, conversationId)));
  }

  /**
   * Records an inbound message. Returns null when (clinicId,
   * providerMessageId) already exists — the dedupe BACKSTOP (invariant 1's
   * last line of defense); callers must then skip buffering.
   */
  async appendInbound(params: {
    conversationId: string;
    providerMessageId: string;
    content: InboundContent;
    at: Date;
  }): Promise<MessageRow | null> {
    const kind: MessageKind = params.content.kind;
    const body =
      params.content.kind === 'text'
        ? { text: params.content.text }
        : { mediaUrl: params.content.mediaUrl, caption: 'caption' in params.content ? params.content.caption : undefined };

    const [row] = await this.db
      .insert(messages)
      .values({
        clinicId: this.clinicId,
        conversationId: params.conversationId,
        direction: 'inbound',
        source: 'contact',
        kind,
        body,
        providerMessageId: params.providerMessageId,
        status: 'delivered',
        createdAt: params.at,
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  /** Outbox insert — the message row exists (status=queued) BEFORE any send attempt. */
  async appendOutboundQueued(params: {
    conversationId: string;
    source: 'agent' | 'human' | 'reminder' | 'campaign' | 'system';
    kind: MessageKind;
    intent: NonNullable<MessageRow['intent']>;
  }): Promise<MessageRow> {
    const [row] = await this.db
      .insert(messages)
      .values({
        clinicId: this.clinicId,
        conversationId: params.conversationId,
        direction: 'outbound',
        source: params.source,
        kind: params.kind,
        body: {},
        intent: params.intent,
        status: 'queued',
      })
      .returning();
    return row!;
  }

  async getMessageById(id: string): Promise<MessageRow | null> {
    const [row] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.clinicId, this.clinicId), eq(messages.id, id)))
      .limit(1);
    return row ?? null;
  }

  /**
   * FIFO cursor for outbound (SPEC §4.3): uuidv7 ids are time-ordered, so the
   * smallest queued id is the next message allowed to leave. "Slots are 14h
   * or 16h" must never arrive before "let me check availability".
   */
  async firstQueuedOutboundId(conversationId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.clinicId, this.clinicId),
          eq(messages.conversationId, conversationId),
          eq(messages.direction, 'outbound'),
          eq(messages.status, 'queued'),
        ),
      )
      .orderBy(asc(messages.id))
      .limit(1);
    return row?.id ?? null;
  }

  async markMessageSent(
    id: string,
    providerMessageId: string | null,
    renderedText: string | null,
  ): Promise<void> {
    await this.db
      .update(messages)
      .set({
        status: 'sent',
        providerMessageId,
        ...(renderedText !== null ? { body: { text: renderedText } } : {}),
      })
      .where(and(eq(messages.clinicId, this.clinicId), eq(messages.id, id)));
  }

  async markMessageFailed(id: string, error: unknown): Promise<void> {
    await this.db
      .update(messages)
      .set({ status: 'failed', error: { reason: String(error) } })
      .where(and(eq(messages.clinicId, this.clinicId), eq(messages.id, id)));
  }

  async setTranscription(messageId: string, transcription: string): Promise<void> {
    await this.db
      .update(messages)
      .set({ transcription })
      .where(and(eq(messages.clinicId, this.clinicId), eq(messages.id, messageId)));
  }
}
