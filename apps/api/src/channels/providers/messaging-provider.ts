// MessagingProvider port — SPEC §4.5, DOCUMENTO-EXECUTIVO §3.2.
// The insurance abstraction: WAHA is the permanent adapter, CloudApiProvider
// stays a stub, but every flow speaks only this interface + OutboundIntent so
// an emergency migration (Meta ban wave) is an adapter swap, not a rewrite.
import type { ChoiceIntent, NormalizedReply, OutboundIntent, Provider } from '@dalio/shared';

/** The slice of a channels row an adapter needs to address a session. */
export interface ChannelRef {
  externalId: string;
  /** WAHA container host override — null uses the default WAHA_BASE_URL. */
  host?: string | null;
}

export interface SendResult {
  /** Null when the provider response carried no usable id (send still succeeded). */
  providerMessageId: string | null;
}

export interface MessagingProvider {
  readonly name: Provider;

  /**
   * Delivers an intent. `template` intents must be resolved to text upstream
   * (TemplateRenderService) for WAHA — only the Cloud adapter would map them
   * to Meta template sends. Adapters render `choice` themselves: numbered
   * text on WAHA, interactive buttons on Cloud (iron rule #2).
   */
  send(channel: ChannelRef, to: string, intent: OutboundIntent): Promise<SendResult>;

  /**
   * Resolves an inbound text against a pending choice ("1", "1)", the option
   * label…) so flows only ever see option ids, never rendered strings.
   */
  parseInboundReply(text: string, expecting?: ChoiceIntent): NormalizedReply;

  /**
   * The 24h-window check modeled from day one (SPEC §4.5): WAHA always true,
   * Cloud does the window math. Every proactive send calls this.
   */
  canSendFreeform(lastInboundAt: Date | null): boolean;

  /** Humanization: typing indicator during debounce and before sends. */
  startTyping(channel: ChannelRef, to: string): Promise<void>;
}

/** DI token for the per-provider registry (channels.provider column → adapter). */
export const PROVIDER_REGISTRY = Symbol('PROVIDER_REGISTRY');

export interface ProviderRegistry {
  get(name: Provider): MessagingProvider;
}
