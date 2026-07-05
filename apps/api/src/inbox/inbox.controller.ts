// Inbox HTTP surface — SPEC §7 (Inbox): the clinic's ONLY human channel.
// The WhatsApp number belongs to the company (DOCUMENTO-EXECUTIVO §3.2), so
// there is no clinic-side phone to fall back on: everything a human does —
// read, reply, take over, approve supervised drafts — happens here.
//
// Auth/tenancy: global AuthGuard + TenantGuard already ran for /api/v1/*;
// every repository call below is tenant-scoped by construction.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ConversationsRepository } from '../conversations/conversations.repository';
import { ContactsRepository } from '../conversations/contacts.repository';
import { OutboxService } from '../outbound/outbox.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { InboxEventsService } from './inbox-events.service';
import { InboxRepository } from './inbox.repository';

/**
 * Human send pauses the agent for this long — same window as an agent-side
 * handoff (agent-turn.handler.ts): once a human enters the thread, the agent
 * answering over them is instant-churn territory; 8h covers a shift and
 * self-heals if nobody resumes explicitly.
 */
const HUMAN_TAKEOVER_PAUSE_MS = 8 * 60 * 60 * 1000;

/** SSE keep-alive comment interval — under common 30–60s proxy idle timeouts. */
const SSE_HEARTBEAT_MS = 25_000;

const sendMessageSchema = z.object({ text: z.string().trim().min(1).max(4096) });
const pauseSchema = z.object({ hours: z.number().int().min(1).max(168).optional() });
const listQuerySchema = z.object({ status: z.enum(['open', 'closed']).default('open') });

@Controller('api/v1/conversations')
export class InboxController {
  constructor(
    private readonly inboxRepo: InboxRepository,
    private readonly conversationsRepo: ConversationsRepository,
    private readonly contactsRepo: ContactsRepository,
    private readonly outbox: OutboxService,
    private readonly inboxEvents: InboxEventsService,
    private readonly tenant: TenantContextService,
  ) {}

  @Get()
  list(@Query() query: unknown) {
    const parsed = listQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.inboxRepo.listConversations(parsed.data.status);
  }

  /**
   * SSE stream of InboxEvent id-pointers for the active clinic. Declared
   * BEFORE the :id routes — Nest matches in declaration order and 'stream'
   * would otherwise be captured as a conversation id.
   */
  @Get('stream')
  async stream(@Req() req: Request, @Res() res: Response): Promise<void> {
    const clinicId = this.tenant.requireClinicId();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(': connected\n\n');

    const unsubscribe = await this.inboxEvents.subscribe(clinicId, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(`: hb\n\n`), SSE_HEARTBEAT_MS);

    // Browser tab closed, network drop, server shutdown: everything funnels
    // into 'close'. Skipping this cleanup leaks a listener per reconnect.
    req.on('close', () => {
      clearInterval(heartbeat);
      void unsubscribe();
      res.end();
    });
  }

  /** Morning digest — what the night shift produced (SPEC §5 handoff promise). */
  @Get('digest')
  digest(@Query('since') since?: string) {
    const parsed = since ? new Date(since) : new Date(Date.now() - 16 * 60 * 60 * 1000);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('since must be an ISO-8601 datetime');
    }
    return this.inboxRepo.digest(parsed);
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const conversation = await this.getConversationOr404(id);
    const contact = await this.contactsRepo.getById(conversation.contactId);
    return { ...conversation, contact };
  }

  @Get(':id/messages')
  async messages(
    @Param('id') id: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    await this.getConversationOr404(id);
    const parsedLimit = limit ? Number(limit) : undefined;
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException('limit must be a positive integer');
    }
    return this.conversationsRepo.listMessagesPage(id, { before, limit: parsedLimit });
  }

  /**
   * Human reply. Goes through the same outbox/FIFO/canContact machinery as
   * every other send (iron rules #2/#4 hold for humans too) and AUTO-PAUSES
   * the agent: replying is an implicit takeover (SPEC §6 — Handoff).
   */
  @Post(':id/messages')
  async sendMessage(@Param('id') id: string, @Body() body: unknown) {
    const parsed = sendMessageSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const conversation = await this.getConversationOr404(id);

    const messageId = await this.outbox.send({
      conversationId: conversation.id,
      channelId: conversation.channelId,
      intent: { kind: 'text', text: parsed.data.text },
      source: 'human',
    });
    await this.pauseAndNotify(conversation.id, HUMAN_TAKEOVER_PAUSE_MS);
    return { messageId };
  }

  @Post(':id/pause')
  async pause(@Param('id') id: string, @Body() body: unknown) {
    const parsed = pauseSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    await this.getConversationOr404(id);
    await this.pauseAndNotify(id, (parsed.data.hours ?? 8) * 60 * 60 * 1000);
    return { ok: true };
  }

  @Post(':id/resume')
  async resume(@Param('id') id: string) {
    await this.getConversationOr404(id);
    await this.conversationsRepo.resume(id);
    await this.inboxEvents.publish(this.tenant.requireClinicId(), {
      type: 'conversation',
      conversationId: id,
    });
    return { ok: true };
  }

  /**
   * Approve a supervised-mode draft: guarded draft → queued flip (double
   * approval loses harmlessly), then hand it to the outbound FIFO.
   */
  @Post(':id/drafts/:messageId/approve')
  async approveDraft(@Param('id') id: string, @Param('messageId') messageId: string) {
    const conversation = await this.getConversationOr404(id);
    await this.getDraftOr404(id, messageId);

    const approved = await this.conversationsRepo.approveDraft(messageId);
    if (!approved) throw new NotFoundException('Rascunho já processado');

    await this.outbox.enqueueApproved({
      messageId,
      conversationId: conversation.id,
      channelId: conversation.channelId,
    });
    return { ok: true };
  }

  /** Discard a draft (kept as status='discarded' — the trust-ramp audit trail). */
  @Post(':id/drafts/:messageId/reject')
  async rejectDraft(@Param('id') id: string, @Param('messageId') messageId: string) {
    await this.getConversationOr404(id);
    await this.getDraftOr404(id, messageId);

    const discarded = await this.conversationsRepo.discardDraft(messageId);
    if (!discarded) throw new NotFoundException('Rascunho já processado');

    await this.inboxEvents.publish(this.tenant.requireClinicId(), {
      type: 'message',
      conversationId: id,
      messageId,
    });
    return { ok: true };
  }

  private async getConversationOr404(id: string) {
    const conversation = await this.conversationsRepo.getById(id);
    if (!conversation) throw new NotFoundException('Conversa não encontrada');
    return conversation;
  }

  private async getDraftOr404(conversationId: string, messageId: string) {
    const message = await this.conversationsRepo.getMessageById(messageId);
    // Conversation match matters: the route params are attacker-controlled
    // and the messageId alone would let one clinic user act on another
    // conversation's draft within the same clinic unnoticed.
    if (!message || message.conversationId !== conversationId || message.direction !== 'outbound') {
      throw new NotFoundException('Rascunho não encontrado');
    }
    return message;
  }

  private async pauseAndNotify(conversationId: string, pauseMs: number): Promise<void> {
    const ctx = this.tenant.get();
    await this.conversationsRepo.pause(
      conversationId,
      new Date(Date.now() + pauseMs),
      ctx?.userId ?? 'unknown',
    );
    await this.inboxEvents.publish(this.tenant.requireClinicId(), {
      type: 'conversation',
      conversationId,
    });
  }
}
