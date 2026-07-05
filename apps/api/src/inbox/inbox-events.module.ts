// Standalone module for the inbox event bus so publishers everywhere in the
// pipeline (conversations, outbound, agent) can import it without touching
// the InboxModule's HTTP surface — and without creating module cycles: this
// module depends only on the global QueuesModule's REDIS client.
import { Module } from '@nestjs/common';
import { InboxEventsService } from './inbox-events.service';

@Module({
  providers: [InboxEventsService],
  exports: [InboxEventsService],
})
export class InboxEventsModule {}
