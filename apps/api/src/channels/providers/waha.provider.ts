// WAHA adapter — the permanent production provider (DOCUMENTO-EXECUTIVO §3.2).
// Renders OutboundIntents as plain WhatsApp messages (choice → numbered text)
// and normalizes WAHA's chatId addressing to/from E.164.
import { Injectable } from '@nestjs/common';
import type { ChoiceIntent, NormalizedReply, OutboundIntent } from '@dalio/shared';
import type { ChannelRef, MessagingProvider, SendResult } from './messaging-provider';
import { parseChoiceReply, renderChoiceAsText } from './choice-parsing';
import { WahaApiClient } from './waha-api.client';

/** '+5511999998888' → '5511999998888@c.us' (WAHA chat addressing). */
export const toChatId = (e164: string) => `${e164.replace(/\D/g, '')}@c.us`;

@Injectable()
export class WahaProvider implements MessagingProvider {
  readonly name = 'waha' as const;

  constructor(private readonly api: WahaApiClient) {}

  async send(channel: ChannelRef, to: string, intent: OutboundIntent): Promise<SendResult> {
    const chatId = toChatId(to);
    const session = channel.externalId;

    switch (intent.kind) {
      case 'text':
        return this.sendText(channel, session, chatId, intent.text);
      case 'choice':
        return this.sendText(channel, session, chatId, renderChoiceAsText(intent));
      case 'media': {
        const response = await this.api.post<WahaMessageResponse>(
          '/api/sendFile',
          { session, chatId, file: { url: intent.mediaUrl }, caption: intent.caption },
          channel.host,
        );
        return { providerMessageId: extractMessageId(response) };
      }
      case 'template':
        // Iron rule #2 upstream contract: OutboundWorker resolves template
        // intents to text via TemplateRenderService before the adapter. If
        // one reaches here, the pipeline is miswired — failing loudly beats
        // sending "{{nome}}" to a client.
        throw new Error('template intents must be rendered before reaching WahaProvider');
    }
  }

  parseInboundReply(text: string, expecting?: ChoiceIntent): NormalizedReply {
    return parseChoiceReply(text, expecting);
  }

  /** Unofficial API has no messaging window — modeled anyway (SPEC §4.5). */
  canSendFreeform(_lastInboundAt: Date | null): boolean {
    return true;
  }

  async startTyping(channel: ChannelRef, to: string): Promise<void> {
    await this.api.post(
      '/api/startTyping',
      { session: channel.externalId, chatId: toChatId(to) },
      channel.host,
    );
  }

  private async sendText(
    channel: ChannelRef,
    session: string,
    chatId: string,
    text: string,
  ): Promise<SendResult> {
    const response = await this.api.post<WahaMessageResponse>(
      '/api/sendText',
      { session, chatId, text },
      channel.host,
    );
    return { providerMessageId: extractMessageId(response) };
  }
}

/** WAHA response shapes vary by engine (NOWEB/GOWS) — extract defensively. */
interface WahaMessageResponse {
  id?: string | { id?: string };
  key?: { id?: string };
}

function extractMessageId(response: WahaMessageResponse): string | null {
  if (typeof response.id === 'string') return response.id;
  if (response.id && typeof response.id.id === 'string') return response.id.id;
  if (response.key && typeof response.key.id === 'string') return response.key.id;
  return null;
}
