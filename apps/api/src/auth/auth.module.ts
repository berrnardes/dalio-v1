import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { createAuth } from './auth';

/**
 * Wraps @thallesp/nestjs-better-auth: mounts the better-auth handler and
 * re-adds body parsers with req.rawBody enabled (the WAHA webhook HMAC
 * check needs the raw payload).
 *
 * The library's global AuthGuard is disabled here and registered explicitly
 * in AppModule instead: APP_GUARD ordering across imported dynamic modules
 * is not deterministic, and TenantGuard must run AFTER AuthGuard (it reads
 * request.session). Both guards live in AppModule's providers array, where
 * order is guaranteed.
 */
@Module({
  imports: [
    BetterAuthModule.forRootAsync({
      isGlobal: true,
      disableGlobalAuthGuard: true,
      useFactory: (db: Db, config: ConfigService) => ({
        auth: createAuth(db, config),
        bodyParser: { rawBody: true },
      }),
      inject: [DB, ConfigService],
    }),
  ],
})
export class AuthModule {}
