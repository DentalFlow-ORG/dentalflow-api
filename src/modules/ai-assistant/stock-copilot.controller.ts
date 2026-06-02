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
import { StockCopilotDto } from './dto/stock-copilot.dto';
import { StockCopilotService } from './stock-copilot.service';

@Controller('stock/purchase-list')
@TenantScoped()
@RequiresBillingAccess()
@Roles('OWNER', 'ASSISTANT')
@Throttle({ default: { ttl: 60_000, limit: 5 } })
export class StockCopilotController {
  constructor(
    private readonly copilotService: StockCopilotService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  /**
   * Returns the most-recently persisted stock copilot analysis for this clinic,
   * without checking the current purchase-list state.  Safe to call on every
   * page mount — DB-only, no AI, no quota consumed.
   */
  @Get('copilot-summary/latest')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async getLatestCopilotSummary(
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    const result = await this.copilotService.getLatestAnalysis(clinicId);

    if (result === null) {
      return res.status(HttpStatus.NO_CONTENT).send();
    }

    return res.status(HttpStatus.OK).json(result);
  }

  @Post('copilot-summary')
  async getCopilotSummary(
    @CurrentUser() user: AuthUser,
    @Body() dto: StockCopilotDto,
    @Res() res: Response,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    const result = await this.copilotService.getCopilotSummary(
      user.id,
      clinicId,
      dto.forceRefresh ?? false,
    );

    if (result === null) {
      return res.status(HttpStatus.NO_CONTENT).send();
    }

    return res.status(HttpStatus.OK).json(result);
  }
}
