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
}

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
