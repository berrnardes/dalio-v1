// Campaign constants — SPEC §4 (Phase 6, reactivation). Shared between the
// dispatcher (api) and the dashboard (web) so suppression reasons render
// consistently and copy stays behind templateKeys (iron rule #2).

/**
 * Why a segment member was NOT messaged — recorded on campaign_recipients so
 * the clinic sees "suppressed: future appointment" instead of a silent skip.
 * These rules are the difference between reactivation and spray-and-pray
 * (DOCUMENTO-EXECUTIVO §3.4): messaging someone who already booked, opted
 * out, or is mid-conversation burns trust AND ban score.
 */
export const SUPPRESSION_REASONS = {
  OPTED_OUT: 'opted_out',
  FUTURE_APPOINTMENT: 'future_appointment',
  RECENT_CONTACT: 'recent_contact',
  ACTIVE_CONVERSATION: 'active_conversation',
} as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[keyof typeof SUPPRESSION_REASONS];

/** Suppress contacts we messaged in the last N days (any outbound). */
export const RECENT_CONTACT_DAYS = 14;
/** Suppress contacts whose conversation had inbound activity in the last N days. */
export const ACTIVE_CONVERSATION_DAYS = 7;
/** A campaign reply/booking within this window counts as campaign-attributed. */
export const ATTRIBUTION_WINDOW_DAYS = 30;

/** Default reactivation copy key (seeded with variants — anti-ban variation). */
export const REACTIVATION_TEMPLATE_KEY = 'campaign_reactivation';
