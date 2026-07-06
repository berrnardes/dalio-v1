// Campaign attribution — Phase 6. The two hooks that close the reactivation
// loop for the R$ dashboard (DOCUMENTO-EXECUTIVO §1: "clientes reativados"
// is a hero metric): a contact replying after a campaign send marks
// repliedAt; a booking within the attribution window links
// convertedAppointmentId. Both are best-effort side notes on hot paths —
// they must never break a turn or a booking.
import { Injectable, Logger } from '@nestjs/common';
import { CampaignsRepository } from './campaigns.repository';

@Injectable()
export class CampaignAttributionService {
  private readonly logger = new Logger(CampaignAttributionService.name);

  constructor(private readonly campaignsRepo: CampaignsRepository) {}

  /** Called on every inbound turn (cheap no-op when no fresh send exists). */
  async recordReply(contactId: string): Promise<void> {
    try {
      await this.campaignsRepo.recordReply(contactId);
    } catch (err) {
      this.logger.warn(`Reply attribution failed for contact ${contactId}: ${String(err)}`);
    }
  }

  /** Called by the appointment lifecycle on every successful booking. */
  async recordConversion(contactId: string, appointmentId: string): Promise<void> {
    try {
      await this.campaignsRepo.recordConversion(contactId, appointmentId);
    } catch (err) {
      this.logger.warn(`Conversion attribution failed for contact ${contactId}: ${String(err)}`);
    }
  }
}
