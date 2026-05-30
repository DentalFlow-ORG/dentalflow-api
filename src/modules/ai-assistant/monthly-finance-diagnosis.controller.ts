import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { MonthlyFinanceDiagnosisDto } from './dto/monthly-finance-diagnosis.dto';
import { MonthlyFinanceDiagnosisService } from './monthly-finance-diagnosis.service';

@Controller('finance/ai')
@TenantScoped()
@RequiresBillingAccess()
@Roles('OWNER')
@Throttle({ default: { ttl: 60_000, limit: 10 } })
export class MonthlyFinanceDiagnosisController {
  constructor(
    private readonly diagnosisService: MonthlyFinanceDiagnosisService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Post('monthly-diagnosis')
  @HttpCode(HttpStatus.OK)
  diagnose(@CurrentUser() user: AuthUser, @Body() dto: MonthlyFinanceDiagnosisDto) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.diagnosisService.diagnose(user.id, clinicId, dto);
  }
}
