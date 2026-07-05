// Scheduling module — the native calendar (SPEC §6). Native-first is a
// product decision (DOCUMENTO-EXECUTIVO §4): clinics without a system are
// the easiest customers; external calendar integrations come later.
import { Module } from '@nestjs/common';
import { AppointmentsRepository } from './appointments.repository';
import { AvailabilityService } from './availability.service';
import { ClinicsRepository } from './clinics.repository';
import { ProfessionalsRepository } from './professionals.repository';
import { SchedulingController } from './scheduling.controller';

@Module({
  controllers: [SchedulingController],
  providers: [ClinicsRepository, ProfessionalsRepository, AppointmentsRepository, AvailabilityService],
  exports: [ClinicsRepository, ProfessionalsRepository, AppointmentsRepository, AvailabilityService],
})
export class SchedulingModule {}
