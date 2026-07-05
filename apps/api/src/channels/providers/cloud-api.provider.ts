// WhatsApp Cloud API adapter — deliberately a STUB (SPEC §1 non-goals).
// This is the insurance policy, not the plan: it exists so the provider port
// stays honest (contract tests run against it) and so the genuinely portable
// logic — the 24h freeform window — is real from day one. Implementing sends
// only happens if a Meta ban wave forces the emergency exit or a franchise
// client demands the official API (DOCUMENTO-EXECUTIVO §3.2).
import { Injectable } from '@nestjs/common';
import type { ChoiceIntent, NormalizedReply, OutboundIntent } from '@dalio/shared';
import type { ChannelRef, MessagingProvider, SendResult } from './messaging-provider';
import { parseChoiceReply } from './choice-parsing';

/** Meta's customer-service window: freeform allowed 24h after last inbound. */
const FREEFORM_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class CloudApiProvider implements MessagingProvider {
  readonly name = 'cloud_api' as const;

  send(_channel: ChannelRef, _to: string, _intent: OutboundIntent): Promise<SendResult> {
    return Promise.reject(
      new Error(
        'CloudApiProvider is a stub (insurance adapter). Implement sends only when migrating.',
      ),
    );
  }

  parseInboundReply(text: string, expecting?: ChoiceIntent): NormalizedReply {
    // Cloud button replies arrive with the button payload as the text — the
    // shared parser already matches option ids exactly, so both transports
    // normalize identically.
    return parseChoiceReply(text, expecting);
  }

  canSendFreeform(lastInboundAt: Date | null): boolean {
    if (!lastInboundAt) return false;
    return Date.now() - lastInboundAt.getTime() < FREEFORM_WINDOW_MS;
  }

  startTyping(_channel: ChannelRef, _to: string): Promise<void> {
    return Promise.resolve();
  }
}
