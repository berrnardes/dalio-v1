// Scheduling READ API — SPEC §7: availability + appointment listing +
// professionals, consumed by the dashboard (Phase 3). Appointment write
// endpoints (book/cancel/confirm/no-show) live in AppointmentsController
// (RemindersModule) so every write drives the reminder cadence.
import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AppointmentsRepository } from './appointments.repository';
import { AvailabilityService } from './availability.service';
import { ProfessionalsRepository } from './professionals.repository';

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
