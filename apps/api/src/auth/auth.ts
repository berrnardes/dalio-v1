import { ConfigService } from '@nestjs/config';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import type { Db } from '../db/db.module';
import * as authSchema from '../db/schema/auth';

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
