import {
  Body,
  Controller,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { AbnormalConsumptionCopilotDto } from './dto/abnormal-consumption-copilot.dto';
import { AbnormalConsumptionCopilotService } from './abnormal-consumption-copilot.service';

@Controller('stock/abnormal-consumption')
@TenantScoped()
@RequiresBillingAccess()
@Roles('OWNER', 'ASSISTANT')
@Throttle({ default: { ttl: 60_000, limit: 5 } })
export class AbnormalConsumptionCopilotController {
  constructor(
    private readonly copilotService: AbnormalConsumptionCopilotService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Post('copilot-summary')
  async getCopilotSummary(
    @CurrentUser() user: AuthUser,
    @Body() dto: AbnormalConsumptionCopilotDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    const result = await this.copilotService.getCopilotSummary(
      user.id,
      clinicId,
      dto,
    );

    if (result === null) {
      res.status(HttpStatus.NO_CONTENT).end();
      return;
    }

    return result;
  }
}
