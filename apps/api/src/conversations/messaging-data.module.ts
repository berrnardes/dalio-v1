// Messaging data — contacts/conversations repositories in their own module
// so both ConversationsModule (workers) and OutboundModule (dispatch) can
// import them without forming a cycle: Conversations → Agent → Outbound must
// NOT lead back into Conversations (Nest resolves cyclic imports to
// undefined at decoration time — same class of bug as queues/redis.token).
import { Module } from '@nestjs/common';
import { ContactsRepository } from './contacts.repository';
import { ConversationsRepository } from './conversations.repository';

@Module({
  providers: [ContactsRepository, ConversationsRepository],
  exports: [ContactsRepository, ConversationsRepository],
})
export class MessagingDataModule {}
