// Scheduling data — the low-level calendar providers (clinic/professional/
// appointment repositories + the availability engine) in their own module so
// both SchedulingModule (read API) and RemindersModule (Phase 4 lifecycle:
// book+reminders, cancel+backfill) can depend on them WITHOUT a cycle.
//
// Same pattern and reason as MessagingDataModule: RemindersModule needs these
// providers, SchedulingModule's controller needs RemindersModule's
// BookingService — a shared low-level module breaks the loop (Nest resolves
// cyclic module imports to undefined at decoration time).
import { Module } from '@nestjs/common';
import { AppointmentsRepository } from './appointments.repository';
import { AvailabilityService } from './availability.service';
import { ClinicsRepository } from './clinics.repository';
import { ProfessionalsRepository } from './professionals.repository';

@Module({
  providers: [ClinicsRepository, ProfessionalsRepository, AppointmentsRepository, AvailabilityService],
  exports: [ClinicsRepository, ProfessionalsRepository, AppointmentsRepository, AvailabilityService],
})
export class SchedulingDataModule {}
