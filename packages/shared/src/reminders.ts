// Anti-no-show engine constants — SPEC §4 (Phase 4). The confirmation choice
// the reminder asks and the template keys its copy comes from. Iron rule #2:
// reminder copy is a templateKey (never raw strings in flows); the option
// LABELS below are choice mechanics the adapter renders as a numbered list.

/**
 * Stable ids for the confirmation choice. The scanner sets these on the
 * conversation's flowContext.options so the turn handler can map a reply
 * ("1" / "confirmar") back to an action deterministically — never the LLM
 * (a wrong "confirmed" is worse than a missed turn).
 */
export const CONFIRMATION_OPTIONS = {
  CONFIRM: 'confirm',
  RESCHEDULE: 'reschedule',
  CANCEL: 'cancel',
} as const;
export type ConfirmationOptionId =
  (typeof CONFIRMATION_OPTIONS)[keyof typeof CONFIRMATION_OPTIONS];

/**
 * Template keys for each reminder kind's copy (seeded per-clinic or global).
 * Confirmation kinds render into a `choice` prompt; informational kinds are
 * plain `template` intents resolved by the outbound worker.
 */
export const REMINDER_TEMPLATE_KEYS = {
  confirm_24h: 'reminder_confirm_24h',
  reminder_3h: 'reminder_3h',
  at_risk_2h: 'reminder_at_risk',
  no_show_followup: 'reminder_no_show_followup',
  booking_confirmation: 'reminder_booking_confirmation',
} as const;

/** Copy for the "a slot opened" waitlist backfill message. */
export const WAITLIST_TEMPLATE_KEY = 'waitlist_slot_open';
