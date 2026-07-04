import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';

@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async check() {
    let dbOk = false;
    try {
      await this.db.execute(sql`select 1`);
      dbOk = true;
    } catch {
      // reported below
    }
    return { status: dbOk ? 'ok' : 'degraded', db: dbOk };
  }
}
