// Contact identity — iron rule #8: the E.164 phone per clinic IS the
// identity; provider ids never leak in. Upsert is conflict-driven so
// concurrent inbound workers converge on one row.
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { contacts } from '../db/schema';
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
}
