// Bull Board — SPEC §8 (Phase 7): queue eyes for a human. Mounted as raw
// express middleware, which BYPASSES the Nest guard chain — hence its own
// gate: HTTP basic auth from BULL_BOARD_PASSWORD, and without that env the
// route simply does not exist (dev/test/misconfigured prod expose nothing).
import { timingSafeEqual } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUES } from '@dalio/shared';

const ROUTE = '/internal/queues';
const USER = 'ops';

export function mountBullBoard(app: NestExpressApplication, password: string | undefined): void {
  if (!password) return;

  const adapter = new ExpressAdapter();
  adapter.setBasePath(ROUTE);
  createBullBoard({
    queues: Object.values(QUEUES).map(
      (name) => new BullMQAdapter(app.get<Queue>(getQueueToken(name))),
    ),
    serverAdapter: adapter,
  });

  app.use(ROUTE, basicAuth(password), adapter.getRouter());
}

/** Constant-time basic auth: ops:<BULL_BOARD_PASSWORD>. */
function basicAuth(password: string) {
  const expected = Buffer.from(`${USER}:${password}`);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const given = Buffer.from(header.replace(/^Basic /, ''), 'base64');
    const ok = given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) {
      res.setHeader('WWW-Authenticate', 'Basic realm="dalio-ops"');
      res.status(401).send('auth required');
      return;
    }
    next();
  };
}
