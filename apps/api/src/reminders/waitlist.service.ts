// Waitlist backfill — SPEC §4 (Phase 4). A cancelled/no-show appointment
// leaves an empty chair; if someone is waiting for that service, one
// notification recovers the revenue. Rebooking itself goes through the agent
// (the notified contact replies and books normally) — we only surface the
// opening, we don't auto-book (the waiter may no longer want it).
import { Injectable, Logger } from '@nestjs/common';
import { TZDate } from '@date-fns/tz';
import { WAITLIST_TEMPLATE_KEY } from '@dalio/shared';
import type { OutboundIntent } from '@dalio/shared';
import { ContactsRepository } from '../conversations/contacts.repository';
import { TemplateRenderService } from '../outbound/template-render.service';
import { ReminderSenderService } from './reminder-sender.service';
import { WaitlistRepository } from './waitlist.repository';

@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    private readonly waitlistRepo: WaitlistRepository,
    private readonly contactsRepo: ContactsRepository,
    private readonly templateRender: TemplateRenderService,
    private readonly sender: ReminderSenderService,
  ) {}

  /**
   * A slot for `serviceId` at `slotStart` just opened. Notifies the single
   * oldest matching waiter (window contains the slot), then marks them
   * notified so a later freed slot moves to the next person. Best-effort:
   * a missing template or unreachable clinic is logged, never thrown — a
   * failed backfill must not roll back the cancellation that triggered it.
   */
  async onSlotFreed(params: {
    serviceId: string;
    serviceName: string;
    slotStart: Date;
    timezone: string;
  }): Promise<void> {
    const waiter = await this.waitlistRepo.findMatchingForSlot(params.serviceId, params.slotStart);
    if (!waiter) return;

    try {
      const contact = await this.contactsRepo.getById(waiter.contactId);
      if (!contact) return;

      const local = new TZDate(params.slotStart, params.timezone);
      const text = await this.templateRender.render(WAITLIST_TEMPLATE_KEY, {
        nome: contact.name ?? '',
        servico: params.serviceName,
        data: `${String(local.getDate()).padStart(2, '0')}/${String(local.getMonth() + 1).padStart(2, '0')}`,
        hora: `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`,
      });
      const intent: OutboundIntent = { kind: 'text', text };

      const sent = await this.sender.send({ contactId: waiter.contactId, intent });
      // Mark notified only if the message actually entered the outbox, so an
      // unreachable-clinic skip leaves the waiter eligible for the next slot.
      if (sent) await this.waitlistRepo.markNotified(waiter.id);
    } catch (err) {
      this.logger.warn(`Waitlist backfill failed for waiter ${waiter.id}: ${String(err)}`);
    }
  }
}
