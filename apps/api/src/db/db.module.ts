import { Global, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export const DB = Symbol('DB');
export type Db = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql };

/** Closes the pg pool on shutdown — graceful deploys and test teardown both
 *  need the event loop free of lingering sockets. */
@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}
  async onApplicationShutdown() {
    await this.db.$client.end({ timeout: 5 });
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: (config: ConfigService): Db => {
        const client = postgres(config.getOrThrow<string>('DATABASE_URL'));
        return drizzle(client, { schema }) as Db;
      },
      inject: [ConfigService],
    },
    DbLifecycle,
  ],
  exports: [DB],
})
export class DbModule {}
