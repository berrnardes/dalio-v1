// Contact identity — iron rule #8: the E.164 phone per clinic IS the
// identity; provider ids never leak in. Upsert is conflict-driven so
// concurrent inbound workers converge on one row.
import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { campaignRecipients, contacts, conversations, messages, waitlist } from '../db/schema';
import { TenantScopedRepository } from '../tenancy/tenant-scoped.repository';

export type ContactRow = typeof contacts.$inferSelect;

@Injectable()
export class ContactsRepository extends TenantScopedRepository {
  /** Insert-or-fetch by phone. First inbound contact also stamps consentAt (LGPD: contact initiated). */
  async upsertByPhone(phone: string): Promise<ContactRow> {
    const [inserted] = await this.db
      .insert(contacts)
      .values({ clinicId: this.clinicId, phone, source: 'inbound', consentAt: new Date() })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;

    const [existing] = await this.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.clinicId, this.clinicId), eq(contacts.phone, phone)))
      .limit(1);
    if (!existing) throw new Error(`Contact upsert race lost twice for ${phone}`);
    return existing;
  }

  async getById(id: string): Promise<ContactRow | null> {
    const [row] = await this.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.clinicId, this.clinicId), eq(contacts.id, id)))
      .limit(1);
    return row ?? null;
  }

  /** Mechanical LGPD opt-out (iron rule #4) — every proactive send checks this stamp. */
  async setOptOut(id: string): Promise<void> {
    await this.db
      .update(contacts)
      .set({ optOutAt: new Date() })
      .where(and(eq(contacts.clinicId, this.clinicId), eq(contacts.id, id)));
  }

  async list(limit = 200): Promise<ContactRow[]> {
    return this.db
      .select()
      .from(contacts)
      .where(eq(contacts.clinicId, this.clinicId))
      .orderBy(desc(contacts.createdAt))
      .limit(limit);
  }

  /** Explicit marketing consent (LGPD, Phase 7) — unlocks campaign sends. */
  async setConsent(id: string): Promise<void> {
    await this.db
      .update(contacts)
      .set({ consentAt: new Date() })
      .where(and(eq(contacts.clinicId, this.clinicId), eq(contacts.id, id)));
  }

  /**
   * CSV import (Phase 7). `consented` is the CLINIC'S assertion that these
   * customers agreed to hear from them — it stamps consentAt and is what
   * lets reactivation campaigns reach imported lists. Conflicts (existing
   * phone) update the name only; they never overwrite consent/opt-out state.
   */
  async importMany(
    rows: Array<{ phone: string; name: string | null }>,
    consented: boolean,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const inserted = await this.db
      .insert(contacts)
      .values(
        rows.map((r) => ({
          clinicId: this.clinicId,
          phone: r.phone,
          name: r.name,
          source: 'import',
          consentAt: consented ? new Date() : null,
        })),
      )
      .onConflictDoUpdate({
        target: [contacts.clinicId, contacts.phone],
        set: { name: sql`coalesce(excluded.name, ${contacts.name})` },
      })
      .returning({ id: contacts.id });
    return inserted.length;
  }

  /**
   * LGPD erasure (Phase 7): the right to deletion without corrupting the
   * books. The contact row becomes a tombstone (phone → `erased:<id>` keeps
   * the unique key shape; name/consent gone; optOut stamped so NOTHING can
   * ever be sent), message content and transcriptions are purged, and
   * pending waitlist/campaign rows disappear. Appointments and message
   * SKELETONS (direction/status/timestamps) stay — they are the clinic's
   * financial/audit record and carry no PII once the contact is a tombstone.
   */
  async erase(id: string): Promise<boolean> {
    const [contact] = await this.db
      .update(contacts)
      .set({
        phone: `erased:${id}`,
        name: null,
        consentAt: null,
        optOutAt: new Date(),
        lastVisitAt: null,
      })
      .where(and(eq(contacts.clinicId, this.clinicId), eq(contacts.id, id)))
      .returning({ id: contacts.id });
    if (!contact) return false;

    await this.db
      .update(messages)
      .set({ body: {}, transcription: null, intent: null })
      .where(
        and(
          eq(messages.clinicId, this.clinicId),
          sql`${messages.conversationId} in (
            select id from ${conversations}
            where ${conversations.clinicId} = ${this.clinicId}
              and ${conversations.contactId} = ${id}
          )`,
        ),
      );
    await this.db
      .delete(waitlist)
      .where(and(eq(waitlist.clinicId, this.clinicId), eq(waitlist.contactId, id)));
    await this.db
      .delete(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.clinicId, this.clinicId),
          eq(campaignRecipients.contactId, id),
          sql`${campaignRecipients.sentAt} is null`,
        ),
      );
    return true;
  }
}
