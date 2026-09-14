import {
  Body,
  Controller,
  Get,
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
import { AiAssistantAnalysisType } from '@prisma/client';
import { AiAssistantService } from './ai-assistant.service';
import { AiQuotaService } from './ai-quota.service';
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
    private readonly quotaService: AiQuotaService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get('finance/latest')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER')
  async getLatestFinance(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    const { data, dataReadiness, visibility } = await this.aiService.getLatestFinance(user.id, clinicId);
    const quota = await this.quotaService.getQuota(clinicId, AiAssistantAnalysisType.FINANCE);
    return { data, quota, dataReadiness, visibility };
  }

  @Get('inventory/latest')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER', 'ASSISTANT')
  async getLatestInventory(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    const { data, dataReadiness, visibility } = await this.aiService.getLatestInventory(user.id, clinicId);
    const quota = await this.quotaService.getQuota(clinicId, AiAssistantAnalysisType.INVENTORY);
    return { data, quota, dataReadiness, visibility };
  }

  @Post('finance/analyze')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER')
  async analyzeFinance(
    @CurrentUser() user: AuthUser,
    @Body() dto: AnalyzeFinanceDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    const data = await this.aiService.analyzeFinance(user.id, clinicId, dto.from, dto.to);
    const quota = await this.quotaService.getQuota(clinicId, AiAssistantAnalysisType.FINANCE);
    return { data, quota };
  }

  @Post('inventory/analyze')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER')
  async analyzeInventory(
    @CurrentUser() user: AuthUser,
     
    @Body() _dto: AnalyzeInventoryDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    const data = await this.aiService.analyzeInventory(user.id, clinicId);
    const quota = await this.quotaService.getQuota(clinicId, AiAssistantAnalysisType.INVENTORY);
    return { data, quota };
  }
}
