// Iron rule #2 (CLAUDE.md): no outbound message exists outside this type.
// Adapters render intents per provider (WAHA: numbered text; Cloud API: buttons);
// flows only ever see option ids, never rendered strings.

export interface ChoiceOption {
  id: string;
  label: string;
}

export type OutboundIntent =
  | { kind: 'text'; text: string }
  | { kind: 'choice'; prompt: string; options: ChoiceOption[] }
  | { kind: 'template'; templateKey: string; variables: Record<string, string> }
  | { kind: 'media'; mediaUrl: string; caption?: string };

export type ChoiceIntent = Extract<OutboundIntent, { kind: 'choice' }>;

/** What a provider adapter resolves an inbound reply into. */
export type NormalizedReply =
  | { kind: 'choice'; optionId: string }
  | { kind: 'freeform' };
