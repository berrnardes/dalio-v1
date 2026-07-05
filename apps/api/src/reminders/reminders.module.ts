// Reminders module — SPEC §4 (Phase 4): the anti-no-show engine. Owns the
// appointment state machine (the single write path), the reminder cadence,
// the 1/min scanner + scheduler, waitlist backfill, and the appointment-write
// API. Exports AppointmentLifecycleService so the agent tools (AgentModule)
// route bookings/cancels through the same side-effect chain.
//
// Module graph stays acyclic: it depends on SchedulingDataModule (not
// SchedulingModule) — the low-level calendar providers extracted for exactly
// this, mirroring MessagingDataModule.
import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ChannelsModule } from '../channels/channels.module';
import { MessagingDataModule } from '../conversations/messaging-data.module';
import { OutboundModule } from '../outbound/outbound.module';
import { SchedulingDataModule } from '../scheduling/scheduling-data.module';
import { AppointmentLifecycleService } from './appointment-lifecycle.service';
import { AppointmentsController } from './appointments.controller';
import { ConfirmationBuilder } from './confirmation.builder';
import { ReminderSenderService } from './reminder-sender.service';
import { RemindersRepository } from './reminders.repository';
import { RemindersScanRepository } from './reminders-scan.repository';
import { RemindersScanWorker } from './reminders-scan.worker';
import { RemindersScheduler } from './reminders.scheduler';
import { WaitlistRepository } from './waitlist.repository';
import { WaitlistService } from './waitlist.service';

@Module({
  imports: [
    SchedulingDataModule,
    CatalogModule,
    OutboundModule,
    MessagingDataModule,
    ChannelsModule,
  ],
  controllers: [AppointmentsController],
  providers: [
    AppointmentLifecycleService,
    RemindersRepository,
    RemindersScanRepository,
    WaitlistRepository,
    WaitlistService,
    ReminderSenderService,
    ConfirmationBuilder,
    RemindersScanWorker,
    RemindersScheduler,
  ],
  exports: [AppointmentLifecycleService],
})
export class RemindersModule {}
