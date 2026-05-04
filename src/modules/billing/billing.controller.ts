import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { BillingService } from './billing.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';

@Controller('billing')
@TenantScoped()
@Roles('OWNER')
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Post('checkout-session')
  createCheckoutSession(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCheckoutSessionDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.billingService.createCheckoutSession(clinicId, user.id, dto);
  }

  @Get('template')
  getTemplate() {
    return this.billingService.getTemplate();
  }
}
