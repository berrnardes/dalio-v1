// LGPD/consent gate — iron rule #4: EVERY outbound send passes through here.
// Spam reports are the #1 ban signal AND the LGPD baseline: an opt-out is
// enforced mechanically inside the pipeline, not by anyone remembering a
// list. Conversational replies (agent/human answering an inbound message)
// are always allowed — the contact initiated; proactive traffic is gated.
import { Injectable } from '@nestjs/common';
import type { MessageSource } from '@dalio/shared';
import type { ContactRow } from '../conversations/contacts.repository';

export type ContactDecision = { allowed: true } | { allowed: false; reason: string };

const PROACTIVE_SOURCES: ReadonlySet<MessageSource> = new Set(['reminder', 'campaign']);

@Injectable()
export class CanContactService {
  check(contact: ContactRow, source: MessageSource): ContactDecision {
    if (!PROACTIVE_SOURCES.has(source)) return { allowed: true };

    if (contact.optOutAt) return { allowed: false, reason: 'opt_out' };
    // Per-contact frequency caps join in Phase 6 (campaign suppression rules).
    return { allowed: true };
  }
}
