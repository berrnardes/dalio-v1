import { Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { TenantContextService } from './tenant-context.service';

/**
 * Opens the (empty) tenant store around the request so that TenantGuard —
 * which runs later, after AuthGuard — can fill it and downstream code can
 * read it. Does no I/O and never rejects.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly tenantContext: TenantContextService) {}

  use(_req: Request, _res: Response, next: NextFunction) {
    this.tenantContext.runEmpty(() => next());
  }
}
