// Inbox module — Phase 3 (SPEC §7): the dashboard's human channel. HTTP
// surface + read models; the event bus lives in InboxEventsModule so pipeline
// modules can publish without importing this module's controller graph.
import { Module } from '@nestjs/common';
import { MessagingDataModule } from '../conversations/messaging-data.module';
import { OutboundModule } from '../outbound/outbound.module';
import { InboxEventsModule } from './inbox-events.module';
import { InboxController } from './inbox.controller';
import { InboxRepository } from './inbox.repository';

@Module({
  imports: [MessagingDataModule, OutboundModule, InboxEventsModule],
  controllers: [InboxController],
  providers: [InboxRepository],
})
export class InboxModule {}
