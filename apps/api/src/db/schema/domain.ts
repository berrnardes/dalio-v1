import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  APPOINTMENT_STATUSES,
  CAMPAIGN_KINDS,
  CAMPAIGN_STATUSES,
  CHANNEL_STATUSES,
  CLINIC_STATUSES,
  CONVERSATION_STATUSES,
  DELIVERY_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_KINDS,
  MESSAGE_SOURCES,
  NUMBER_STATES,
  PROVIDERS,
  REMINDER_KINDS,
  TEMPLATE_CATEGORIES,
} from '@dalio/shared';
import type {
  ClinicSettings,
  FlowContext,
  MessageBody,
  OutboundIntent,
  RatePolicy,
  SegmentRules,
} from '@dalio/shared';

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());
const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const clinicStatus = pgEnum('clinic_status', CLINIC_STATUSES);
export const numberState = pgEnum('number_state', NUMBER_STATES);
export const provider = pgEnum('provider', PROVIDERS);
export const channelStatus = pgEnum('channel_status', CHANNEL_STATUSES);
export const conversationStatus = pgEnum('conversation_status', CONVERSATION_STATUSES);
export const messageDirection = pgEnum('message_direction', MESSAGE_DIRECTIONS);
export const messageSource = pgEnum('message_source', MESSAGE_SOURCES);
export const messageKind = pgEnum('message_kind', MESSAGE_KINDS);
export const deliveryStatus = pgEnum('delivery_status', DELIVERY_STATUSES);
export const appointmentStatus = pgEnum('appointment_status', APPOINTMENT_STATUSES);
export const reminderKind = pgEnum('reminder_kind', REMINDER_KINDS);
export const templateCategory = pgEnum('template_category', TEMPLATE_CATEGORIES);
export const campaignKind = pgEnum('campaign_kind', CAMPAIGN_KINDS);
export const campaignStatus = pgEnum('campaign_status', CAMPAIGN_STATUSES);

// ── Multi-tenant core ─────────────────────────────────────────────────────

export const clinics = pgTable('clinics', {
  id: id(),
  authOrgId: text('auth_org_id').unique(),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  timezone: text('timezone').default('America/Sao_Paulo').notNull(),
  status: clinicStatus('status').default('active').notNull(),
  settings: jsonb('settings').$type<ClinicSettings>(),
  createdAt: createdAt(),
});

export const professionals = pgTable('professionals', {
  id: id(),
  clinicId: uuid('clinic_id')
    .references(() => clinics.id)
    .notNull(),
  name: text('name').notNull(),
  active: boolean('active').default(true).notNull(),
});

export const services = pgTable('services', {
  id: id(),
  clinicId: uuid('clinic_id')
    .references(() => clinics.id)
    .notNull(),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  durationMin: integer('duration_min').notNull(),
  returnIntervalDays: integer('return_interval_days'),
  active: boolean('active').default(true).notNull(),
});

// ── Numbers & channels ────────────────────────────────────────────────────

export const numbers = pgTable('numbers', {
  id: id(),
  phone: text('phone').unique().notNull(),
  ddd: text('ddd').notNull(),
  carrier: text('carrier'),
  state: numberState('state').notNull(),
  clinicId: uuid('clinic_id').references(() => clinics.id),
  qualityScore: real('quality_score').default(1.0).notNull(),
  dailyQuota: integer('daily_quota').default(10).notNull(),
  warmupStartedAt: ts('warmup_started_at'),
  activatedAt: ts('activated_at'),
  bannedAt: ts('banned_at'),
  replacedById: uuid('replaced_by_id').references((): AnyPgColumn => numbers.id),
});

export const channels = pgTable(
  'channels',
  {
    id: id(),
    clinicId: uuid('clinic_id')
      .references(() => clinics.id)
      .notNull(),
    provider: provider('provider').notNull(),
    externalId: text('external_id').notNull(),
    numberId: uuid('number_id').references(() => numbers.id),
    status: channelStatus('status').notNull(),
    host: text('host'),
    engine: text('engine'),
    ratePolicy: jsonb('rate_policy').$type<RatePolicy>(),
  },
  (t) => [unique().on(t.provider, t.externalId)],
);

// ── Contacts & conversations ──────────────────────────────────────────────

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    clinicId: uuid('clinic_id')
      .references(() => clinics.id)
      .notNull(),
    phone: text('phone').notNull(),
    name: text('name'),
    source: text('source'),
    consentAt: ts('consent_at'),
    optOutAt: ts('opt_out_at'),
    lastVisitAt: ts('last_visit_at'),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.clinicId, t.phone)],
);

export const conversations = pgTable('conversations', {
  id: id(),
  clinicId: uuid('clinic_id')
    .references(() => clinics.id)
    .notNull(),
  contactId: uuid('contact_id')
    .references(() => contacts.id)
    .notNull(),
  channelId: uuid('channel_id')
    .references(() => channels.id)
    .notNull(),
  status: conversationStatus('status').default('open').notNull(),
  pausedUntil: ts('paused_until'),
  pausedByUserId: text('paused_by_user_id'),
  flowContext: jsonb('flow_context').$type<FlowContext>(),
  lastInboundAt: ts('last_inbound_at'),
  lastOutboundAt: ts('last_outbound_at'),
});

export const messages = pgTable(
  'messages',
  {
    id: id(),
    clinicId: uuid('clinic_id')
      .references(() => clinics.id)
      .notNull(),
    conversationId: uuid('conversation_id')
      .references(() => conversations.id)
      .notNull(),
    direction: messageDirection('direction').notNull(),
    source: messageSource('source').notNull(),
    kind: messageKind('kind').notNull(),
    body: jsonb('body').$type<MessageBody>().notNull(),
    intent: jsonb('intent').$type<OutboundIntent>(),
    transcription: text('transcription'),
    providerMessageId: text('provider_message_id'),
    status: deliveryStatus('status').default('queued').notNull(),
    error: jsonb('error'),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.clinicId, t.providerMessageId),
    index('messages_convo_created_idx').on(t.conversationId, t.createdAt),
  ],
);

// ── Scheduling ────────────────────────────────────────────────────────────

export const appointments = pgTable(
  'appointments',
  {
    id: id(),
    clinicId: uuid('clinic_id')
      .references(() => clinics.id)
      .notNull(),
    contactId: uuid('contact_id')
      .references(() => contacts.id)
      .notNull(),
    serviceId: uuid('service_id')
      .references(() => services.id)
      .notNull(),
    professionalId: uuid('professional_id').references(() => professionals.id),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    status: appointmentStatus('status').notNull(),
    rescheduledToId: uuid('rescheduled_to_id').references((): AnyPgColumn => appointments.id),
    source: text('source').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('appointments_clinic_starts_idx').on(t.clinicId, t.startsAt)],
);

export const reminders = pgTable(
  'reminders',
  {
    id: id(),
    clinicId: uuid('clinic_id')
      .references(() => clinics.id)
      .notNull(),
    appointmentId: uuid('appointment_id')
      .references(() => appointments.id)
      .notNull(),
    kind: reminderKind('kind').notNull(),
    dueAt: ts('due_at').notNull(),
    sentAt: ts('sent_at'),
    cancelledAt: ts('cancelled_at'),
    messageId: uuid('message_id').references(() => messages.id),
  },
  (t) => [
    index('reminders_due_idx')
      .on(t.dueAt)
      .where(sql`${t.sentAt} is null and ${t.cancelledAt} is null`),
  ],
);

export const waitlist = pgTable('waitlist', {
  id: id(),
  clinicId: uuid('clinic_id')
    .references(() => clinics.id)
    .notNull(),
  contactId: uuid('contact_id')
    .references(() => contacts.id)
    .notNull(),
  serviceId: uuid('service_id')
    .references(() => services.id)
    .notNull(),
  windowStart: ts('window_start'),
  windowEnd: ts('window_end'),
  notifiedAt: ts('notified_at'),
  fulfilledAppointmentId: uuid('fulfilled_appointment_id').references(() => appointments.id),
});

// ── Templates & campaigns ─────────────────────────────────────────────────

export const templates = pgTable(
  'templates',
  {
    id: id(),
    clinicId: uuid('clinic_id').references(() => clinics.id),
    key: text('key').notNull(),
    category: templateCategory('category').notNull(),
    variants: jsonb('variants').$type<string[]>().notNull(),
    variables: jsonb('variables').$type<string[]>(),
    providerStatus: jsonb('provider_status'),
  },
  (t) => [unique().on(t.clinicId, t.key)],
);

export const campaigns = pgTable('campaigns', {
  id: id(),
  clinicId: uuid('clinic_id')
    .references(() => clinics.id)
    .notNull(),
  name: text('name').notNull(),
  kind: campaignKind('kind').default('reactivation').notNull(),
  templateKey: text('template_key').notNull(),
  segment: jsonb('segment').$type<SegmentRules>(),
  dailyCap: integer('daily_cap').default(20).notNull(),
  status: campaignStatus('status').default('draft').notNull(),
  startedAt: ts('started_at'),
});

export const campaignRecipients = pgTable('campaign_recipients', {
  id: id(),
  campaignId: uuid('campaign_id')
    .references(() => campaigns.id)
    .notNull(),
  contactId: uuid('contact_id')
    .references(() => contacts.id)
    .notNull(),
  scheduledFor: ts('scheduled_for'),
  sentAt: ts('sent_at'),
  suppressedReason: text('suppressed_reason'),
  repliedAt: ts('replied_at'),
  convertedAppointmentId: uuid('converted_appointment_id').references(() => appointments.id),
});

// ── Per-tenant metering ───────────────────────────────────────────────────

export const usageCounters = pgTable(
  'usage_counters',
  {
    clinicId: uuid('clinic_id')
      .references(() => clinics.id)
      .notNull(),
    month: text('month').notNull(),
    inboundCount: integer('inbound_count').default(0).notNull(),
    outboundCount: integer('outbound_count').default(0).notNull(),
    llmTokensIn: bigint('llm_tokens_in', { mode: 'number' }).default(0).notNull(),
    llmTokensOut: bigint('llm_tokens_out', { mode: 'number' }).default(0).notNull(),
    llmCostCents: integer('llm_cost_cents').default(0).notNull(),
  },
  (t) => [primaryKey({ columns: [t.clinicId, t.month] })],
);
