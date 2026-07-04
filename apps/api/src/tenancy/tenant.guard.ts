import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { clinics } from '../db/schema';
import { TenantContextService } from './tenant-context.service';

/**
 * Runs after the library's global AuthGuard (which attaches request.session)
 * and, for /api/v1/* routes, resolves active organization → clinic into the
 * tenant AsyncLocalStorage context. Non-tenant routes (health, webhooks,
 * /api/auth) pass through untouched.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tenantContext: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { session?: UserSession }>();
    if (!req.path.startsWith('/api/v1/')) return true;

    const session = req.session;
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

    this.tenantContext.set({ clinicId: clinic.id, userId: session.user.id });
    return true;
  }
}
