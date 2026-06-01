import {
  Body,
  Controller,
  Get,
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

  /**
   * Returns the most-recently persisted abnormal-consumption copilot analysis,
   * without checking the current anomaly-list state.  Safe to call on every
   * page mount — DB-only, no AI, no quota consumed.
   */
  @Get('copilot-summary/latest')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async getLatestCopilotSummary(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    const result = await this.copilotService.getLatestAnalysis(clinicId);

    if (result === null) {
      res.status(HttpStatus.NO_CONTENT).end();
      return;
    }

    return result;
  }

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
