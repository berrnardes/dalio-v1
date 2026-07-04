import type { Provider } from './enums';

export type InboundContent =
  | { kind: 'text'; text: string }
  | { kind: 'audio'; mediaUrl: string }
  | { kind: 'image'; mediaUrl: string; caption?: string }
  | { kind: 'document'; mediaUrl: string; caption?: string };

/**
 * Canonical inbound event. Produced by provider webhook handlers, consumed by
 * the `inbound` queue worker. The handler never resolves channel → clinic;
 * that happens in the worker (SPEC §4.1).
 */
export interface InboundMessageEvent {
  provider: Provider;
  channelExternalId: string;
  /** Idempotency key — dedupe layers 1 (Redis SET NX) and 2 (BullMQ jobId). */
  providerMessageId: string;
  /** E.164, e.g. +5511999998888 */
  from: string;
  /** Unix ms */
  timestamp: number;
  content: InboundContent;
}
