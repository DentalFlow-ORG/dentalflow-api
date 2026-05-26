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

  @Post('copilot-summary')
  async getCopilotSummary(
    @CurrentUser() user: AuthUser,
    @Body() dto: StockCopilotDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    const result = await this.copilotService.getCopilotSummary(
      user.id,
      clinicId,
      dto.forceRefresh ?? false,
    );

    if (result === null) {
      res.status(HttpStatus.NO_CONTENT).end();
      return;
    }

    return result;
  }
}
