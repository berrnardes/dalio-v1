// Contacts API — SPEC §7 (built in Phase 7 with the LGPD machinery): list,
// CSV import with the clinic's consent assertion, explicit consent/opt-out
// stamps, and the erasure endpoint (right to deletion). The phone is the
// identity (iron rule #8), so import validates E.164 hard — a malformed
// phone here becomes an unreachable contact forever.
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { ContactsRepository } from './contacts.repository';

const E164 = /^\+\d{10,15}$/;

const importSchema = z.object({
  /** Lines of `phone` or `phone,name` (header line optional). */
  csv: z.string().min(1),
  /** The clinic asserts these customers consented to be contacted (LGPD). */
  consent: z.boolean(),
});

@Controller('api/v1/contacts')
export class ContactsController {
  constructor(private readonly contactsRepo: ContactsRepository) {}

  @Get()
  list() {
    return this.contactsRepo.list();
  }

  @Post('import')
  async import(@Body() body: unknown) {
    const parsed = importSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const rows: Array<{ phone: string; name: string | null }> = [];
    const skipped: string[] = [];
    for (const rawLine of parsed.data.csv.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || /^(telefone|phone)\b/i.test(line)) continue; // blank/header
      const [phone, ...nameParts] = line.split(',').map((s) => s.trim());
      if (!phone || !E164.test(phone)) {
        skipped.push(line);
        continue;
      }
      rows.push({ phone, name: nameParts.join(', ') || null });
    }

    const imported = await this.contactsRepo.importMany(rows, parsed.data.consent);
    return { imported, skipped };
  }

  @Post(':id/optout')
  async optOut(@Param('id') id: string) {
    await this.requireContact(id);
    await this.contactsRepo.setOptOut(id);
    return { ok: true };
  }

  @Post(':id/consent')
  async consent(@Param('id') id: string) {
    await this.requireContact(id);
    await this.contactsRepo.setConsent(id);
    return { ok: true };
  }

  /** LGPD erasure — see ContactsRepository.erase for exactly what remains. */
  @Delete(':id')
  async erase(@Param('id') id: string) {
    if (!(await this.contactsRepo.erase(id))) throw new NotFoundException();
    return { ok: true };
  }

  private async requireContact(id: string) {
    const contact = await this.contactsRepo.getById(id);
    if (!contact) throw new NotFoundException();
    return contact;
  }
}
