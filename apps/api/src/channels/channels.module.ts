// Channels module — webhook ingestion, provider adapters, session health.
// SPEC §6: the only module that talks to WhatsApp transports; everything
// else speaks canonical events and intents.
import { Module } from '@nestjs/common';
import type { Provider as ProviderName } from '@dalio/shared';
import { NumbersModule } from '../numbers/numbers.module';
import { ChannelsRepository } from './channels.repository';
import { CloudApiProvider } from './providers/cloud-api.provider';
import type { MessagingProvider, ProviderRegistry } from './providers/messaging-provider';
import { PROVIDER_REGISTRY } from './providers/messaging-provider';
import { WahaApiClient } from './providers/waha-api.client';
import { WahaProvider } from './providers/waha.provider';
import { SessionHealthWorker } from './session-health.worker';
import { WahaWebhookController } from './waha-webhook.controller';
import { WebhookIngestService } from './webhook-ingest.service';

@Module({
  // NumbersModule: session-health feeds the number quality score (Phase 6).
  imports: [NumbersModule],
  controllers: [WahaWebhookController],
  providers: [
    WebhookIngestService,
    ChannelsRepository,
    WahaApiClient,
    WahaProvider,
    CloudApiProvider,
    SessionHealthWorker,
    {
      // channels.provider column value → adapter instance. Adding a provider
      // is: implement MessagingProvider, register here — nothing else changes.
      provide: PROVIDER_REGISTRY,
      useFactory: (waha: WahaProvider, cloud: CloudApiProvider): ProviderRegistry => {
        const registry = new Map<ProviderName, MessagingProvider>([
          ['waha', waha],
          ['cloud_api', cloud],
        ]);
        return {
          get(name: ProviderName): MessagingProvider {
            const provider = registry.get(name);
            if (!provider) throw new Error(`No messaging provider registered for '${name}'`);
            return provider;
          },
        };
      },
      inject: [WahaProvider, CloudApiProvider],
    },
  ],
  exports: [ChannelsRepository, PROVIDER_REGISTRY, WahaApiClient],
})
export class ChannelsModule {}
