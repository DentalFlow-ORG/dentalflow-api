import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { RequirePlanFeature } from '../../common/decorators/require-plan-feature.decorator';
import { PlanFeature } from '../billing/plan-feature.types';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { ProcedureMarginsQueryDto } from './dto/procedure-margins-query.dto';
import { ProcedureMarginsService } from './procedure-margins.service';

@Controller('finance/analytics')
@TenantScoped()
@Roles('OWNER')
@RequiresBillingAccess()
@RequirePlanFeature(PlanFeature.FINANCE)
export class ProcedureMarginsController {
  constructor(
    private readonly marginsService: ProcedureMarginsService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get('procedure-margins')
  getMargins(
    @CurrentUser() user: AuthUser,
    @Query() query: ProcedureMarginsQueryDto,
  ) {
    return this.marginsService.getMargins(
      this.accessPolicy.assertOwnerAccess(user),
      query,
    );
  }
}
