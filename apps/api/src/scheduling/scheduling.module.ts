// Scheduling module — the native calendar's READ API (SPEC §7): availability,
// appointment listing, professionals. Appointment WRITES (book/cancel/confirm/
// no-show) moved to RemindersModule in Phase 4, where each write also drives
// the reminder cadence and waitlist backfill (the anti-no-show engine).
import { Module } from '@nestjs/common';
import { SchedulingController } from './scheduling.controller';
import { SchedulingDataModule } from './scheduling-data.module';

@Module({
  imports: [SchedulingDataModule],
  controllers: [SchedulingController],
  exports: [SchedulingDataModule],
})
export class SchedulingModule {}
