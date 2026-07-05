// Conversations module — the pipeline's core: inbound normalization, the
// debounce buffer (invariant 2) and the serialized agent turn (invariant 3).
import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { AgentWorker } from './agent.worker';
import { BufferService } from './buffer.service';
import { ContactsRepository } from './contacts.repository';
import { ConversationsRepository } from './conversations.repository';
import { InboundWorker } from './inbound.worker';
import { LoggingTurnHandler, TURN_HANDLER } from './turn-handler';

@Module({
  imports: [ChannelsModule],
  providers: [
    ContactsRepository,
    ConversationsRepository,
    BufferService,
    InboundWorker,
    AgentWorker,
    // Phase 2 swaps this binding for the LangGraph agent.
    { provide: TURN_HANDLER, useClass: LoggingTurnHandler },
  ],
  exports: [ContactsRepository, ConversationsRepository, BufferService],
})
export class ConversationsModule {}
