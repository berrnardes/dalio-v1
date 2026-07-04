import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { toNodeHandler } from 'better-auth/node';
import { json } from 'express';
import { AppModule } from './app.module';
import { AUTH } from './auth/auth.module';
import type { Auth } from './auth/auth.module';

async function bootstrap() {
  // Body parser off globally: better-auth's handler needs the raw request,
  // and the WAHA webhook (Phase 1) will need the raw body for HMAC.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const config = app.get(ConfigService);
  const auth = app.get<Auth>(AUTH);

  const express = app.getHttpAdapter().getInstance();
  express.all(/^\/api\/auth\/.*/, toNodeHandler(auth));

  app.use(json({ limit: '1mb' }));
  app.enableCors({ origin: config.getOrThrow<string>('WEB_ORIGIN'), credentials: true });
  app.enableShutdownHooks();

  await app.listen(config.getOrThrow<number>('PORT'));
}

void bootstrap();
