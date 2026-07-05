// Conversations module — the pipeline's core: inbound normalization, the
// debounce buffer (invariant 2) and the serialized agent turn (invariant 3).
// TURN_HANDLER is provided by AgentModule since Phase 2 (the LangGraph
// agent); the module graph is Conversations → Agent → Outbound →
// MessagingData, acyclic by construction.
import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { ChannelsModule } from '../channels/channels.module';
import { AgentWorker } from './agent.worker';
import { BufferService } from './buffer.service';
import { InboundWorker } from './inbound.worker';
import { MessagingDataModule } from './messaging-data.module';

@Module({
  imports: [ChannelsModule, MessagingDataModule, AgentModule],
  providers: [BufferService, InboundWorker, AgentWorker],
  exports: [BufferService, MessagingDataModule],
})
export class ConversationsModule {}
