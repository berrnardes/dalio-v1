// Agent module — Phase 2: provides TURN_HANDLER (the LangGraph agent) to the
// pipeline. Model tiering (SPEC §5): router/FAQ on the cheap tier, booking on
// the strong tier; both env-configurable (AGENT_ROUTER_MODEL /
// AGENT_BOOKING_MODEL). Without ANTHROPIC_API_KEY the agent degrades to
// observe-only so dev environments and storm tests run without credentials.
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CatalogModule } from '../catalog/catalog.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { MessagingDataModule } from '../conversations/messaging-data.module';
import { TURN_HANDLER } from '../conversations/turn-handler';
import { InboxEventsModule } from '../inbox/inbox-events.module';
import { OutboundModule } from '../outbound/outbound.module';
import { RemindersModule } from '../reminders/reminders.module';
import { SchedulingDataModule } from '../scheduling/scheduling-data.module';
import { AGENT_MODELS, AnthropicAgentModels, UnconfiguredAgentModels } from './agent-models';
import { AgentTurnHandler } from './agent-turn.handler';
import { UsageService } from './usage.service';

@Module({
  imports: [
    MessagingDataModule,
    SchedulingDataModule,
    RemindersModule,
    OutboundModule,
    CampaignsModule,
    CatalogModule,
    InboxEventsModule,
  ],
  providers: [
    UsageService,
    {
      provide: AGENT_MODELS,
      useFactory: (config: ConfigService, usage: UsageService) => {
        const apiKey = config.get<string>('ANTHROPIC_API_KEY');
        if (!apiKey) return new UnconfiguredAgentModels();
        return new AnthropicAgentModels(
          {
            apiKey,
            routerModel: config.getOrThrow<string>('AGENT_ROUTER_MODEL'),
            bookingModel: config.getOrThrow<string>('AGENT_BOOKING_MODEL'),
          },
          usage,
        );
      },
      inject: [ConfigService, UsageService],
    },
    AgentTurnHandler,
    { provide: TURN_HANDLER, useExisting: AgentTurnHandler },
  ],
  exports: [TURN_HANDLER],
})
export class AgentModule {}
