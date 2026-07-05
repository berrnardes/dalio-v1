// Queue topology — SPEC §4.3. One place for queue names and job payload
// shapes so the webhook producer (apps/api HTTP layer) and the BullMQ
// workers never drift. reminders-scan and campaign-dispatch join in
// Phases 4/6.
import type { InboundMessageEvent } from './events.js';
import type { Provider } from './enums.js';

export const QUEUES = {
  /** Webhook → normalization/buffering. jobId = msg:{sanitized providerMessageId} (dedupe layer 2). */
  INBOUND: 'inbound',
  /** Debounce flush → agent turn. Serialized per conversation by the agent lock. */
  AGENT: 'agent',
  /** Outbox dispatch. Rate-limited per channel, FIFO per conversation. */
  OUTBOUND: 'outbound',
  /** Audio → text before the agent turn sees the message. */
  TRANSCRIPTION: 'transcription',
  /** WAHA session.status events → channel status, alerts, auto-restart. */
  SESSION_HEALTH: 'session-health',
  /** 1/min scan of due reminders → confirmation/reminder sends (Phase 4). */
  REMINDERS_SCAN: 'reminders-scan',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type InboundJob = InboundMessageEvent;

/** Fired by the debounce (delayed) or by contention/safety re-enqueues. */
export interface AgentFlushJob {
  conversationId: string;
  clinicId: string;
}

/** References an outbox row (messages table, status=queued) — never carries content. */
export interface OutboundJob {
  messageId: string;
  clinicId: string;
  conversationId: string;
  channelId: string;
}

export interface TranscriptionJob {
  messageId: string;
  clinicId: string;
  conversationId: string;
  mediaUrl: string;
}

/**
 * Reminder scanner tick (Phase 4) — a repeatable heartbeat job, not a
 * long-delayed per-reminder job: the scan-pattern re-reads the DUE set on
 * every tick so reschedules/cancellations are always reflected, and a missed
 * tick never loses a reminder (the next tick picks it up). Carries no
 * payload; the DB is the schedule.
 */
export type ReminderScanJob = Record<string, never>;

export interface SessionHealthJob {
  provider: Provider;
  channelExternalId: string;
  /** Raw provider status string (e.g. WAHA WORKING | SCAN_QR_CODE | FAILED | STOPPED). */
  status: string;
}

/**
 * One entry in the per-conversation Redis buffer (`buffer:{convoId}`).
 * The agent turn receives the drained list as the user's coalesced burst.
 */
export interface BufferedMessage {
  messageId: string;
  /** Resolved text: message body, or transcription for audio, or caption for media. */
  text: string;
  kind: 'text' | 'audio' | 'image' | 'document';
  timestamp: number;
}
