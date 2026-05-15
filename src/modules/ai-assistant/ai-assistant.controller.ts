import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { AiAssistantService } from './ai-assistant.service';
import { AnalyzeFinanceDto } from './dto/analyze-finance.dto';
import { AnalyzeInventoryDto } from './dto/analyze-inventory.dto';

@Controller('ai-assistant')
@TenantScoped()
@RequiresBillingAccess()
// 5 analysis requests per minute per user (global throttle is 120/min)
@Throttle({ default: { ttl: 60_000, limit: 5 } })
export class AiAssistantController {
  constructor(
    private readonly aiService: AiAssistantService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Post('finance/analyze')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER')
  async analyzeFinance(
    @CurrentUser() user: AuthUser,
    @Body() dto: AnalyzeFinanceDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.aiService.analyzeFinance(user.id, clinicId, dto.from, dto.to);
  }

  @Post('inventory/analyze')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER', 'ASSISTANT')
  async analyzeInventory(
    @CurrentUser() user: AuthUser,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @Body() _dto: AnalyzeInventoryDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.aiService.analyzeInventory(user.id, clinicId);
  }
}
