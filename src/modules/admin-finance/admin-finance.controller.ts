import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { AdminFinanceService } from './admin-finance.service';
import { ListSubscriptionsDto } from './dto/list-subscriptions.dto';
import { ListStripeEventsDto } from './dto/list-stripe-events.dto';

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
    @Query() query: ListSubscriptionsDto,
  ) {
    this.accessPolicy.assertPlatformAdmin(user);
    return this.adminFinanceService.listSubscriptions({
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      status: query.status,
      planId: query.planId,
      search: query.search,
      from: query.from,
      to: query.to,
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
    @Query() query: ListStripeEventsDto,
  ) {
    this.accessPolicy.assertPlatformAdmin(user);
    return this.adminFinanceService.listStripeEvents({
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      processed: query.processed === undefined ? undefined : String(query.processed),
      type: query.type,
      from: query.from,
      to: query.to,
    });
  }
}
