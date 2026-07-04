import { Module } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { validateEnv } from './config/env';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { TenancyModule } from './tenancy/tenancy.module';
import { TenantContextMiddleware } from './tenancy/tenant-context.middleware';
import { TenantGuard } from './tenancy/tenant.guard';

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
    CatalogModule,
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
