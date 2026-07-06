// Scheduling module — the native calendar's READ API (SPEC §7): availability,
// appointment listing, professionals. Appointment WRITES (book/cancel/confirm/
// no-show) moved to RemindersModule in Phase 4, where each write also drives
// the reminder cadence and waitlist backfill (the anti-no-show engine).
import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { OnboardingController } from './onboarding.controller';
import { SchedulingController } from './scheduling.controller';
import { SchedulingDataModule } from './scheduling-data.module';

@Module({
  // ChannelsModule: the activation gate checks for a connected channel.
  imports: [SchedulingDataModule, ChannelsModule],
  controllers: [SchedulingController, OnboardingController],
  exports: [SchedulingDataModule],
})
export class SchedulingModule {}
