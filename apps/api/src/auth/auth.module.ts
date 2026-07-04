import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import * as authSchema from '../db/schema/auth';

export const AUTH = Symbol('AUTH');

export function createAuth(db: Db, config: ConfigService) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    secret: config.getOrThrow<string>('BETTER_AUTH_SECRET'),
    baseURL: config.getOrThrow<string>('BETTER_AUTH_URL'),
    trustedOrigins: [config.getOrThrow<string>('WEB_ORIGIN')],
    emailAndPassword: { enabled: true },
    plugins: [organization()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

@Global()
@Module({
  providers: [
    {
      provide: AUTH,
      useFactory: (db: Db, config: ConfigService) => createAuth(db, config),
      inject: [DB, ConfigService],
    },
  ],
  exports: [AUTH],
})
export class AuthModule {}
