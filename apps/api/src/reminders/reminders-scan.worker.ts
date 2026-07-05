// Reminder scanner — SPEC §4 (Phase 4). Fires on the 1/min `reminders-scan`
// tick (RemindersScheduler). The scan pattern (re-read the due set each tick)
// beats long-delayed per-reminder jobs: reschedules/cancellations are always
// honored, a missed tick loses nothing, and a due reminder outside the send
// window simply waits for the next in-window tick.
//
// Per due reminder, inside the owning clinic's tenant scope: skip/cancel the
// dead ones, respect the send window, render the intent (confirmation choice
// or informational template), enqueue via the outbox, and mark it sent.
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { TZDate } from '@date-fns/tz';
import { QUEUES, REMINDER_TEMPLATE_KEYS } from '@dalio/shared';
import type { OutboundIntent, ReminderKind } from '@dalio/shared';
import { ConversationsRepository } from '../conversations/conversations.repository';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AppointmentLifecycleService } from './appointment-lifecycle.service';
import { ConfirmationBuilder, CONFIRMATION_CHOICE_OPTIONS } from './confirmation.builder';
import { ReminderSenderService } from './reminder-sender.service';
import { RemindersRepository } from './reminders.repository';
import { RemindersScanRepository } from './reminders-scan.repository';
import type { DueReminder } from './reminders-scan.repository';
import { isWithinSendWindow } from './send-window';

/** Kinds that ask for a confirmation (choice intent + flowContext). The rest
 *  are one-way informational templates. */
const CONFIRMATION_KINDS: ReadonlySet<ReminderKind> = new Set(['confirm_24h', 'at_risk_2h']);
/** Occupying statuses — a reminder for anything else is stale and cancelled. */
const LIVE_STATUSES = new Set(['scheduled', 'confirmed']);

@Processor(QUEUES.REMINDERS_SCAN)
export class RemindersScanWorker extends WorkerHost {
  private readonly logger = new Logger(RemindersScanWorker.name);

  constructor(
    private readonly scanRepo: RemindersScanRepository,
    private readonly remindersRepo: RemindersRepository,
    private readonly conversationsRepo: ConversationsRepository,
    private readonly confirmationBuilder: ConfirmationBuilder,
    private readonly sender: ReminderSenderService,
    private readonly tenant: TenantContextService,
    // Injected but unused directly here — kept so the module wires the state
    // machine as the single write path; scanner only reads/sends.
    private readonly _lifecycle: AppointmentLifecycleService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const now = new Date();
    const due = await this.scanRepo.findDue(now);
    for (const reminder of due) {
      // Each reminder in its own tenant scope: the scanner is cross-clinic,
      // every downstream repo call must see the right clinicId (iron rule #1).
      await this.tenant
        .run({ clinicId: reminder.clinicId, userId: 'system:reminders' }, () =>
          this.processOne(reminder, now),
        )
        .catch((err) => {
          // One clinic's bad reminder must not stall the whole tick.
          this.logger.warn(`Reminder ${reminder.reminderId} failed: ${String(err)}`);
        });
    }
  }

  private async processOne(reminder: DueReminder, now: Date): Promise<void> {
    // Opt-out: stop re-processing a reminder the canContact gate would block
    // every tick — cancel it (the contact left; LGPD wins).
    if (reminder.contactOptedOut) {
      await this.remindersRepo.cancelById(reminder.reminderId);
      return;
    }

    // Stale: the appointment moved out of an occupying state (defensive —
    // lifecycle cancels reminders on transition, but a race could leave one).
    if (!LIVE_STATUSES.has(reminder.appointmentStatus)) {
      await this.remindersRepo.cancelById(reminder.reminderId);
      return;
    }

    // Already confirmed → a confirmation nudge is pointless; drop it.
    if (CONFIRMATION_KINDS.has(reminder.kind) && reminder.appointmentStatus === 'confirmed') {
      await this.remindersRepo.cancelById(reminder.reminderId);
      return;
    }

    // Send window: defer (leave unsent) — the next in-window tick delivers it.
    if (!isWithinSendWindow(reminder.clinicSettings, reminder.clinicTimezone, now)) return;

    // No connected channel: leave unsent; when the clinic pairs a number the
    // reminder goes out on a later tick (late beats never for a company SIM).
    if (!reminder.channelId) return;

    const intent = await this.buildIntent(reminder);
    const sent = await this.sender.send({
      contactId: reminder.contactId,
      intent,
      channelId: reminder.channelId,
    });
    if (!sent) return; // clinic unreachable — retry next tick

    await this.remindersRepo.markSent(reminder.reminderId, sent.messageId);

    // Confirmations set the conversation to await a reply so the turn handler
    // maps "1"/"confirmar" to an action deterministically (never the LLM).
    if (CONFIRMATION_KINDS.has(reminder.kind)) {
      await this.conversationsRepo.setFlowContext(sent.conversationId, {
        kind: 'awaiting_confirmation',
        appointmentId: reminder.appointmentId,
        options: CONFIRMATION_CHOICE_OPTIONS,
      });
    }
  }

  /** Confirmation kinds → rendered `choice`; informational kinds → `template`
   *  (the outbound worker renders template copy at send time). */
  private buildIntent(reminder: DueReminder): Promise<OutboundIntent> {
    const templateKey = REMINDER_TEMPLATE_KEYS[reminder.kind];
    const variables = this.variablesFor(reminder);
    if (CONFIRMATION_KINDS.has(reminder.kind)) {
      return this.confirmationBuilder.build(templateKey, variables);
    }
    return Promise.resolve({ kind: 'template', templateKey, variables });
  }

  private variablesFor(reminder: DueReminder): Record<string, string> {
    const local = new TZDate(reminder.startsAt, reminder.clinicTimezone);
    return {
      nome: reminder.contactName ?? '',
      servico: reminder.serviceName,
      data: `${String(local.getDate()).padStart(2, '0')}/${String(local.getMonth() + 1).padStart(2, '0')}`,
      hora: `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`,
    };
  }
}
