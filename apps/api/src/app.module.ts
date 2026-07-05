import { Module } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { AgentModule } from './agent/agent.module';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { ChannelsModule } from './channels/channels.module';
import { validateEnv } from './config/env';
import { ConversationsModule } from './conversations/conversations.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { InboxModule } from './inbox/inbox.module';
import { MetricsModule } from './metrics/metrics.module';
import { OutboundModule } from './outbound/outbound.module';
import { QueuesModule } from './queues/queues.module';
import { RemindersModule } from './reminders/reminders.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { TenantContextMiddleware } from './tenancy/tenant-context.middleware';
import { TenantGuard } from './tenancy/tenant.guard';
import { TranscriptionModule } from './transcription/transcription.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
      validate: validateEnv,
    }),
    DbModule,
    AuthModule,
    TenancyModule,
    QueuesModule,
    ChannelsModule,
    ConversationsModule,
    OutboundModule,
    InboxModule,
    TranscriptionModule,
    CatalogModule,
    SchedulingModule,
    RemindersModule,
    MetricsModule,
    AgentModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: AuthGuard attaches request.session; TenantGuard reads it.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Opens the tenant ALS store; TenantGuard fills it after authentication.
    consumer.apply(TenantContextMiddleware).forRoutes('api/v1/*path');
  }
}
