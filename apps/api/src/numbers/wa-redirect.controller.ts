// Public WhatsApp redirect — DOCUMENTO-EXECUTIVO §3.2 (Phase 6): every
// published surface (Instagram bio, Google Business, ads) points at
// `dominio.com/wa/<slug>`, NEVER at a raw number. A ban swap changes the
// active number row; every published link heals instantly with zero edits —
// this is the reachability half of ban recovery.
import { Controller, Get, NotFoundException, Param, Redirect } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { NumbersRepository } from './numbers.repository';

@Controller('wa')
export class WaRedirectController {
  constructor(private readonly numbersRepo: NumbersRepository) {}

  @Get(':slug')
  @AllowAnonymous()
  @Redirect(undefined, 302)
  async redirect(@Param('slug') slug: string) {
    const phone = await this.numbersRepo.findActivePhoneByClinicSlug(slug);
    // 404 body stays generic on purpose: the route is public and must not
    // leak whether a slug exists, is suspended, or is mid-ban-swap.
    if (!phone) throw new NotFoundException();
    return { url: `https://wa.me/${phone.replace(/^\+/, '')}` };
  }
}
