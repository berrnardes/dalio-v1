// Appointment writes — SPEC §7. Every state transition goes through the
// lifecycle service (RemindersModule) so booking generates the reminder
// cadence and cancel/no-show cancel it + backfill the waitlist. The read
// endpoints stay in SchedulingController.
import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { AppointmentLifecycleService } from './appointment-lifecycle.service';
import { WaitlistRepository } from './waitlist.repository';

const createAppointmentSchema = z.object({
  contactId: z.string().uuid(),
  serviceId: z.string().uuid(),
  startsAtISO: z.string().min(1),
});

const addWaitlistSchema = z.object({
  contactId: z.string().uuid(),
  serviceId: z.string().uuid(),
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
});

@Controller('api/v1')
export class AppointmentsController {
  constructor(
    private readonly lifecycle: AppointmentLifecycleService,
    private readonly waitlistRepo: WaitlistRepository,
  ) {}

  @Post('appointments')
  async create(@Body() body: unknown) {
    const parsed = createAppointmentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const result = await this.lifecycle.book({ ...parsed.data, source: 'human' });
    if (!result.ok) throw new BadRequestException(result.reason);
    return result;
  }

  @Post('appointments/:id/confirm')
  async confirm(@Param('id') id: string) {
    if (!(await this.lifecycle.confirm(id))) {
      throw new NotFoundException('No active appointment with this id');
    }
    return { ok: true };
  }

  @Post('appointments/:id/cancel')
  async cancel(@Param('id') id: string) {
    if (!(await this.lifecycle.cancel(id))) {
      throw new NotFoundException('No active appointment with this id');
    }
    return { ok: true };
  }

  @Post('appointments/:id/no-show')
  async noShow(@Param('id') id: string) {
    if (!(await this.lifecycle.markNoShow(id))) {
      throw new NotFoundException('No active appointment with this id');
    }
    return { ok: true };
  }

  @Post('appointments/:id/complete')
  async complete(@Param('id') id: string) {
    if (!(await this.lifecycle.markCompleted(id))) {
      throw new NotFoundException('No active appointment with this id');
    }
    return { ok: true };
  }

  @Post('waitlist')
  async addToWaitlist(@Body() body: unknown) {
    const parsed = addWaitlistSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.waitlistRepo.add({
      contactId: parsed.data.contactId,
      serviceId: parsed.data.serviceId,
      windowStart: parsed.data.windowStart ? new Date(parsed.data.windowStart) : null,
      windowEnd: parsed.data.windowEnd ? new Date(parsed.data.windowEnd) : null,
    });
  }
}
