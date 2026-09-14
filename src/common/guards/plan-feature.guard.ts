import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { PlanCapabilitiesService } from '../../modules/billing/plan-capabilities.service';
import { PlanFeature } from '../../modules/billing/plan-feature.types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { REQUIRES_PLAN_FEATURE_KEY } from '../decorators/require-plan-feature.decorator';
import { AuthenticatedRequest } from '../types/authenticated-request.type';

@Injectable()
export class PlanFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly planCapabilities: PlanCapabilitiesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const feature = this.reflector.getAllAndOverride<PlanFeature | undefined>(
      REQUIRES_PLAN_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!feature) return true;

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;

    if (user.role === UserRole.ADMIN) return true;

    await this.planCapabilities.assertFeature(user.clinicId!, feature);
    return true;
  }
}
