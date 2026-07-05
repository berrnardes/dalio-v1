// Single source of truth for domain enums. The Drizzle pgEnums in apps/api
// derive from these arrays — never redeclare the literals there.

export const CLINIC_STATUSES = ['active', 'suspended'] as const;
export type ClinicStatus = (typeof CLINIC_STATUSES)[number];

export const NUMBER_STATES = [
  'provisioning',
  'warming',
  'standby',
  'active',
  'degraded',
  'banned',
  'retired',
] as const;
export type NumberState = (typeof NUMBER_STATES)[number];

export const PROVIDERS = ['waha', 'cloud_api'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const CHANNEL_STATUSES = [
  'provisioning',
  'pairing',
  'connected',
  'disconnected',
  'failed',
] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export const CONVERSATION_STATUSES = ['open', 'closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_SOURCES = [
  'contact',
  'agent',
  'human',
  'reminder',
  'campaign',
  'system',
] as const;
export type MessageSource = (typeof MESSAGE_SOURCES)[number];

export const MESSAGE_KINDS = [
  'text',
  'audio',
  'image',
  'document',
  'template',
  'system',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

// 'draft'/'discarded' are supervised-mode states (Phase 3): the agent's reply
// waits for human approval in the inbox. Only 'queued' enters the outbound
// FIFO; drafts are invisible to the worker until approved (draft → queued).
export const DELIVERY_STATUSES = [
  'draft',
  'discarded',
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const APPOINTMENT_STATUSES = [
  'scheduled',
  'confirmed',
  'completed',
  'no_show',
  'cancelled',
  'rescheduled',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const REMINDER_KINDS = [
  'booking_confirmation',
  'confirm_24h',
  'reminder_3h',
  'at_risk_2h',
  'no_show_followup',
] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export const TEMPLATE_CATEGORIES = ['utility', 'marketing'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const CAMPAIGN_KINDS = ['reactivation'] as const;
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];

export const CAMPAIGN_STATUSES = ['draft', 'running', 'paused', 'done'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
