import 'reflect-metadata';
// Sentry must initialize before anything else loads (its instrumentation
// patches module internals). Env-gated: no SENTRY_DSN, no overhead.
import * as Sentry from '@sentry/node';
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    // Message content never reaches Sentry (iron rule #7): errors carry
    // stacks and ids only; we don't attach request bodies.
    sendDefaultPii: false,
    tracesSampleRate: 0.1,
  });
}

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { mountBullBoard } from './queues/bull-board';

async function bootstrap() {
  // bodyParser off per @thallesp/nestjs-better-auth requirements; the auth
  // module re-adds json/urlencoded with req.rawBody enabled (webhook HMAC).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const config = app.get(ConfigService);

  app.enableCors({ origin: config.getOrThrow<string>('WEB_ORIGIN'), credentials: true });
  app.enableShutdownHooks();

  // Bull Board (Phase 7): internal ops route, only when a password is set.
  mountBullBoard(app, config.get<string>('BULL_BOARD_PASSWORD'));

  await app.listen(config.getOrThrow<number>('PORT'));
}

void bootstrap();
