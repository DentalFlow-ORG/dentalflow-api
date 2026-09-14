import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import {
  ApplySuggestedCategoryDto,
  BatchClassifyExpenseDto,
  ClassifyExpenseDto,
} from './dto/classify-expense.dto';
import { ExpenseClassifierService } from './expense-classifier.service';
import { FinanceIdParamDto } from '../finance/dto/finance-param.dto';

@Controller('finance/transactions')
@TenantScoped()
@RequiresBillingAccess()
@Roles('OWNER')
@Throttle({ default: { ttl: 60_000, limit: 30 } })
export class ExpenseClassifierController {
  constructor(
    private readonly classifierService: ExpenseClassifierService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Post('classify-expenses/batch')
  @HttpCode(HttpStatus.OK)
  classifyBatch(
    @CurrentUser() user: AuthUser,
    @Body() dto: BatchClassifyExpenseDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.classifierService.classifyBatch(user.id, clinicId, dto);
  }

  @Post(':id/classify-expense')
  @HttpCode(HttpStatus.OK)
  classifyExpense(
    @CurrentUser() user: AuthUser,
    @Param() params: FinanceIdParamDto,
    @Body() dto: ClassifyExpenseDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.classifierService.classifyExpense(
      user.id,
      clinicId,
      params.id,
      dto,
    );
  }

  @Patch(':id/apply-suggested-category')
  applySuggestedCategory(
    @CurrentUser() user: AuthUser,
    @Param() params: FinanceIdParamDto,
    @Body() dto: ApplySuggestedCategoryDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.classifierService.applySuggestedCategory(
      clinicId,
      params.id,
      dto,
    );
  }
}
