// Outbound module — the outbox, the LGPD gate, template rendering, and the
// rate-limited dispatch worker. OutboxService is the single entry point any
// feature uses to send (iron rules #2 and #4 are structural here).
import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { MessagingDataModule } from '../conversations/messaging-data.module';
import { InboxEventsModule } from '../inbox/inbox-events.module';
import { CanContactService } from './can-contact.service';
import { OutboundWorker } from './outbound.worker';
import { OutboxService } from './outbox.service';
import { TemplateRenderService } from './template-render.service';
import { TemplatesRepository } from './templates.repository';

@Module({
  // MessagingDataModule (not ConversationsModule): keeps the module graph
  // acyclic now that ConversationsModule imports AgentModule → OutboundModule.
  imports: [ChannelsModule, MessagingDataModule, InboxEventsModule],
  providers: [
    OutboxService,
    OutboundWorker,
    CanContactService,
    TemplateRenderService,
    TemplatesRepository,
  ],
  exports: [OutboxService, CanContactService, TemplateRenderService],
})
export class OutboundModule {}
