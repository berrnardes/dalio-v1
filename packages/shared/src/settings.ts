import type { ChoiceOption } from './intents.js';

/** Per-clinic configuration stored in clinics.settings (jsonb). */
export interface ClinicSettings {
  agentPersonaPrompt?: string;
  /** 0=Sunday … 6=Saturday, times 'HH:mm' in the clinic's timezone. */
  workingHours?: Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, { open: string; close: string }>>;
  /** Proactive sends only inside this window (clinic-local). */
  sendWindow?: { start: string; end: string };
  /** Inbound debounce; default 7000. */
  debounceMs?: number;
  /** Reminder cadence offsets in minutes before startsAt, per kind. */
  reminderOffsets?: { confirm24h?: number; reminder3h?: number; atRisk2h?: number };
  /**
   * Pilot trust ramp: when true, agent replies are saved as drafts
   * (messages.status='draft') for human approval in the inbox instead of
   * being sent. Deterministic opt-out confirmations bypass this — LGPD
   * compliance never waits for a human.
   */
  supervisedMode?: boolean;
  /**
   * Baseline no-show rate (percent, default 20 — sector runs 15–30%) used to
   * ESTIMATE recovered-no-show revenue on the metrics dashboard: of the
   * appointments confirmed via reminder, this share would statistically have
   * become empty chairs. An estimate label in the UI, never billed truth.
   */
  noShowRatePct?: number;
  /**
   * Onboarding checklist (Phase 7 — DEPLOYMENT.md §6): a clinic only
   * activates with everything true. Each item is a real adoption
   * prerequisite: without the redirect swap the agent gets no leads; without
   * inbox training handoffs rot; without a catalog the agent can't quote.
   */
  onboarding?: {
    redirectInBio?: boolean;
    adsUpdated?: boolean;
    inboxTrained?: boolean;
    catalogFilled?: boolean;
  };
  /** Pilot success targets (Phase 7) — the monthly design-partner scorecard. */
  pilotGoals?: {
    noShowRatePctMax?: number;
    underSixtySecondsPctMin?: number;
    autonomousBookingsMin?: number;
  };
}

/** Keys of the onboarding checklist, in onboarding-conversation order. */
export const ONBOARDING_ITEMS = [
  'redirectInBio',
  'adsUpdated',
  'inboxTrained',
  'catalogFilled',
] as const;
export type OnboardingItem = (typeof ONBOARDING_ITEMS)[number];

/** Anti-ban policy stored in channels.rate_policy (jsonb). Never global constants. */
export interface RatePolicy {
  maxPerDay: number;
  minJitterMs: number;
  maxJitterMs: number;
  sendWindow?: { start: string; end: string };
}

/**
 * Pointer to what the conversation is currently waiting for. Read by the agent
 * router; the LangGraph checkpointer owns the actual conversational state.
 */
export type FlowContext =
  | { kind: 'awaiting_confirmation'; appointmentId: string; options: ChoiceOption[] }
  | { kind: 'awaiting_campaign_reply'; campaignId: string }
  | { kind: 'none' };

export interface MessageBody {
  text?: string;
  mediaUrl?: string;
  caption?: string;
}

/** Reactivation segment rules stored in campaigns.segment (jsonb). */
export interface SegmentRules {
  serviceIds?: string[];
  /** Days past the expected return date (service.returnIntervalDays). */
  overdueDaysMin?: number;
  overdueDaysMax?: number;
}
