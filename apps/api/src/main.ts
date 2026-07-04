import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  // bodyParser off per @thallesp/nestjs-better-auth requirements; the auth
  // module re-adds json/urlencoded with req.rawBody enabled (webhook HMAC).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const config = app.get(ConfigService);

  app.enableCors({ origin: config.getOrThrow<string>('WEB_ORIGIN'), credentials: true });
  app.enableShutdownHooks();

  await app.listen(config.getOrThrow<number>('PORT'));
}

void bootstrap();
