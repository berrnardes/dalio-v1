// Conversations + messages persistence for the pipeline. Tenant-scoped
// (iron rule #1); workers open the tenant scope from the job payload.
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lt, notInArray } from 'drizzle-orm';
import type { FlowContext, InboundContent, MessageKind } from '@dalio/shared';
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

  /**
   * Inbox timeline page (Phase 3). Cursor pagination on the uuidv7 id
   * (time-ordered): `before` fetches the page older than a message the
   * client already has. Returned oldest-first, ready to render.
   */
  async listMessagesPage(
    conversationId: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<MessageRow[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.clinicId, this.clinicId),
          eq(messages.conversationId, conversationId),
          opts.before ? lt(messages.id, opts.before) : undefined,
        ),
      )
      .orderBy(desc(messages.id))
      .limit(Math.min(opts.limit ?? 50, 200));
    return rows.reverse();
  }

  /** Human takeover / handoff: the agent stays silent until `until` passes. */
  async pause(conversationId: string, until: Date, byUserId: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ pausedUntil: until, pausedByUserId: byUserId })
      .where(and(eq(conversations.clinicId, this.clinicId), eq(conversations.id, conversationId)));
  }

  /** Hands the thread back to the agent (inbox "reativar agente" action). */
  async resume(conversationId: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ pausedUntil: null, pausedByUserId: null })
      .where(and(eq(conversations.clinicId, this.clinicId), eq(conversations.id, conversationId)));
  }

  /**
   * Sets what the conversation is waiting for (Phase 4: awaiting_confirmation
   * after a reminder). The inbound worker reads this to skip debounce for a
   * structured "1", and the turn handler reads it to parse a confirmation
   * reply deterministically before any LLM call.
   */
  async setFlowContext(conversationId: string, flowContext: FlowContext): Promise<void> {
    await this.db
      .update(conversations)
      .set({ flowContext })
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

  /**
   * Supervised mode (Phase 3): the agent's reply parks as a draft awaiting
   * human approval in the inbox. Drafts never enter the outbound FIFO —
   * the worker's cursor only sees status='queued'.
   */
  async appendOutboundDraft(params: {
    conversationId: string;
    kind: MessageKind;
    intent: NonNullable<MessageRow['intent']>;
  }): Promise<MessageRow> {
    const [row] = await this.db
      .insert(messages)
      .values({
        clinicId: this.clinicId,
        conversationId: params.conversationId,
        direction: 'outbound',
        source: 'agent',
        kind: params.kind,
        body: {},
        intent: params.intent,
        status: 'draft',
      })
      .returning();
    return row!;
  }

  /**
   * draft → queued, guarded by the current status so a double-click (or two
   * operators) can't approve twice. Returns the row only when THIS call won.
   */
  async approveDraft(id: string): Promise<MessageRow | null> {
    const [row] = await this.db
      .update(messages)
      .set({ status: 'queued' })
      .where(
        and(eq(messages.clinicId, this.clinicId), eq(messages.id, id), eq(messages.status, 'draft')),
      )
      .returning();
    return row ?? null;
  }

  /** draft → discarded (kept, not deleted: the audit trail of what the agent
   *  wanted to say is exactly what the pilot's trust ramp needs to review). */
  async discardDraft(id: string): Promise<boolean> {
    const rows = await this.db
      .update(messages)
      .set({ status: 'discarded' })
      .where(
        and(eq(messages.clinicId, this.clinicId), eq(messages.id, id), eq(messages.status, 'draft')),
      )
      .returning({ id: messages.id });
    return rows.length > 0;
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
