// Fleet ops endpoints — DOCUMENTO-EXECUTIVO §3.2 (Phase 6). Internal
// operation surface (authenticated dashboard session): list the pool, create
// a SIM into it, drive lifecycle transitions, and trigger the ban-swap
// runbook. Numbers are company infrastructure — these endpoints act on the
// fleet, not on the caller's clinic.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { NUMBER_STATES } from '@dalio/shared';
import { NumbersRepository } from './numbers.repository';
import { NumbersService } from './numbers.service';

const createNumberSchema = z.object({
  phone: z.string().regex(/^\+\d{10,15}$/, 'E.164 expected'),
  ddd: z.string().min(2).max(3),
  carrier: z.string().optional(),
  isCanary: z.boolean().optional(),
});

const transitionSchema = z.object({
  to: z.enum(NUMBER_STATES),
  clinicId: z.string().uuid().optional(),
});

@Controller('api/v1/numbers')
export class NumbersController {
  constructor(
    private readonly numbersRepo: NumbersRepository,
    private readonly numbers: NumbersService,
  ) {}

  @Get()
  list() {
    return this.numbersRepo.listAll();
  }

  /** New SIM enters as 'provisioning'; move it to 'warming' to start the ramp. */
  @Post()
  async create(@Body() body: unknown) {
    const parsed = createNumberSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.numbersRepo.create({ ...parsed.data, state: 'provisioning' });
  }

  @Post(':id/transition')
  async transition(@Param('id') id: string, @Body() body: unknown) {
    const parsed = transitionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const extra: Record<string, unknown> = {};
    if (parsed.data.clinicId) extra.clinicId = parsed.data.clinicId;
    if (parsed.data.to === 'warming') extra.warmupStartedAt = new Date();
    if (parsed.data.to === 'active') extra.activatedAt = new Date();
    try {
      return await this.numbers.transition(id, parsed.data.to, extra);
    } catch (err) {
      throw new BadRequestException(String(err instanceof Error ? err.message : err));
    }
  }

  /** The ban runbook trigger: mark banned + swap in the oldest standby. */
  @Post(':id/replace')
  async replace(@Param('id') id: string) {
    const result = await this.numbers.replaceBanned(id);
    if (!result) throw new NotFoundException('No standby number available — provision a SIM');
    return result;
  }
}
