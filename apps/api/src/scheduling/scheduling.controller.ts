// Scheduling API — SPEC §7: appointments/professionals CRUD + availability,
// consumed by the dashboard (Phase 3) and exercised today by the agent tools.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { AppointmentsRepository } from './appointments.repository';
import { AvailabilityService } from './availability.service';
import { ProfessionalsRepository } from './professionals.repository';

const createAppointmentSchema = z.object({
  contactId: z.string().uuid(),
  serviceId: z.string().uuid(),
  startsAtISO: z.string().min(1),
});

const createProfessionalSchema = z.object({ name: z.string().min(1) });

@Controller('api/v1')
export class SchedulingController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly appointmentsRepo: AppointmentsRepository,
    private readonly professionalsRepo: ProfessionalsRepository,
  ) {}

  @Get('availability')
  getAvailability(@Query('serviceId') serviceId: string, @Query('date') date: string) {
    if (!serviceId || !date) throw new BadRequestException('serviceId and date are required');
    return this.availability.getSlots(serviceId, date);
  }

  @Get('appointments')
  listAppointments(@Query('from') from?: string, @Query('to') to?: string) {
    const now = Date.now();
    const fromDate = from ? new Date(from) : new Date(now);
    const toDate = to ? new Date(to) : new Date(now + 7 * 86_400_000);
    return this.appointmentsRepo.listByRange(fromDate, toDate);
  }

  @Post('appointments')
  async createAppointment(@Body() body: unknown) {
    const parsed = createAppointmentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const result = await this.availability.book({ ...parsed.data, source: 'human' });
    if (!result.ok) throw new BadRequestException(result.reason);
    return result;
  }

  @Post('appointments/:id/cancel')
  async cancelAppointment(@Param('id') id: string) {
    const cancelled = await this.appointmentsRepo.cancel(id);
    if (!cancelled) throw new NotFoundException('No active appointment with this id');
    return { ok: true };
  }

  @Get('professionals')
  listProfessionals() {
    return this.professionalsRepo.listActive();
  }

  @Post('professionals')
  createProfessional(@Body() body: unknown) {
    const parsed = createProfessionalSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.professionalsRepo.create(parsed.data.name);
  }
}
