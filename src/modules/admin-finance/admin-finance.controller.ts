import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { AdminFinanceService } from './admin-finance.service';

@Controller('admin/finance')
@Roles('ADMIN')
export class AdminFinanceController {
  constructor(
    private readonly adminFinanceService: AdminFinanceService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get('summary')
  getSummary(@CurrentUser() user: AuthUser) {
    this.accessPolicy.assertPlatformAdmin(user);
    return this.adminFinanceService.getSummary();
  }

  @Get('subscriptions')
  listSubscriptions(
    @CurrentUser() user: AuthUser,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('planId') planId?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    this.accessPolicy.assertPlatformAdmin(user);
    return this.adminFinanceService.listSubscriptions({
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      status,
      planId,
      search,
      from,
      to,
    });
  }

  @Get('plans')
  listPlans(@CurrentUser() user: AuthUser) {
    this.accessPolicy.assertPlatformAdmin(user);
    return this.adminFinanceService.listPlans();
  }

  @Get('stripe-events')
  listStripeEvents(
    @CurrentUser() user: AuthUser,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('processed') processed?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    this.accessPolicy.assertPlatformAdmin(user);
    return this.adminFinanceService.listStripeEvents({
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      processed,
      type,
      from,
      to,
    });
  }
}
