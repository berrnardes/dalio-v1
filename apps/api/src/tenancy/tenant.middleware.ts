import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import { AUTH } from '../auth/auth.module';
import type { Auth } from '../auth/auth.module';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { clinics } from '../db/schema';
import { TenantContextService } from './tenant-context.service';

/** Applied to /api/v1/* — resolves session → active organization → clinic. */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
    private readonly tenantContext: TenantContextService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) throw new UnauthorizedException();

    const orgId = session.session.activeOrganizationId;
    if (!orgId) throw new ForbiddenException('No active clinic selected');

    const [clinic] = await this.db
      .select({ id: clinics.id, status: clinics.status })
      .from(clinics)
      .where(eq(clinics.authOrgId, orgId))
      .limit(1);
    if (!clinic) throw new ForbiddenException('Clinic not found for active organization');
    if (clinic.status !== 'active') throw new ForbiddenException('Clinic is suspended');

    this.tenantContext.run({ clinicId: clinic.id, userId: session.user.id }, () => next());
  }
}
