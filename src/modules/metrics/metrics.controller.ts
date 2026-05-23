import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { MetricsService } from './metrics.service';

@Controller('metrics')
@TenantScoped()
@Roles('OWNER')
@RequiresBillingAccess()
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get('productivity')
  getProductivitySummary(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.metricsService.getProductivitySummary(clinicId);
  }
}
