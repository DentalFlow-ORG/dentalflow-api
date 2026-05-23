import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { BillingService } from '../../modules/billing/billing.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { REQUIRES_BILLING_ACCESS_KEY } from '../decorators/requires-billing-access.decorator';
import { PaymentRequiredException } from '../exceptions/payment-required.exception';
import { AuthenticatedRequest } from '../types/authenticated-request.type';

@Injectable()
export class BillingAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly billingService: BillingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiresBillingAccess = this.reflector.getAllAndOverride<boolean>(
      REQUIRES_BILLING_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiresBillingAccess) return true;

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;

    if (user.role === UserRole.ADMIN) {
      return true;
    }

    if (!user.clinicId) {
      throw new ForbiddenException('Vínculo com clínica obrigatório.');
    }

    const billingStatus =
      await this.billingService.getCurrentSubscriptionStatus(user.clinicId);

    if (billingStatus.accessAllowed) {
      return true;
    }

    throw new PaymentRequiredException(
      billingStatus.message || 'Escolha um plano para continuar.',
      {
        status: billingStatus.status,
        requiresPlanSelection: billingStatus.requiresPlanSelection,
        requiresPayment: billingStatus.requiresPayment,
      },
    );
  }
}
