import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { BillingService } from './billing.service';
import { ChangeSubscriptionPlanDto } from './dto/change-subscription-plan.dto';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { StartTrialDto } from './dto/start-trial.dto';

@Controller('billing')
@TenantScoped()
@Roles('OWNER')
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get('plans')
  @Roles('OWNER', 'DENTIST', 'ASSISTANT')
  getPlans() {
    return this.billingService.getPlans();
  }

  @Get('subscription')
  getSubscription(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.billingService.getSubscription(clinicId);
  }

  @Get('subscription/current')
  @Roles('OWNER', 'DENTIST', 'ASSISTANT')
  getCurrentSubscriptionStatus(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.billingService.getCurrentSubscriptionStatus(clinicId);
  }

  @Post('checkout-session')
  createCheckoutSession(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCheckoutSessionDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.billingService.createCheckoutSession(clinicId, user.id, dto);
  }

  @Post('trial/start')
  startTrial(@CurrentUser() user: AuthUser, @Body() dto: StartTrialDto) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.billingService.startTrial(clinicId, dto);
  }

  @Post('portal-session')
  createPortalSession(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.billingService.createPortalSession(clinicId);
  }

  @Post('subscription/cancel')
  cancelSubscription(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.billingService.cancelSubscription(clinicId);
  }

  @Post('subscription/change-plan')
  changeSubscriptionPlan(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangeSubscriptionPlanDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.billingService.changeSubscriptionPlan(clinicId, dto);
  }

  @Get('template')
  getTemplate() {
    return this.billingService.getTemplate();
  }
}
