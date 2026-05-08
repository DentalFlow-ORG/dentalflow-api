import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { AppointmentPaymentDto } from './dto/appointment-payment.dto';
import { CreateFinancialCategoryDto } from './dto/create-financial-category.dto';
import { CreateFinancialTransactionDto } from './dto/create-financial-transaction.dto';
import { CreateFixedExpenseDto } from './dto/create-fixed-expense.dto';
import {
  FinancePeriodQueryDto,
  ListFinancialTransactionsDto,
} from './dto/finance-query.dto';
import { UpdateFinancialCategoryDto } from './dto/update-financial-category.dto';
import { UpdateFinancialTransactionDto } from './dto/update-financial-transaction.dto';
import { UpdateFixedExpenseDto } from './dto/update-fixed-expense.dto';
import { FinanceService } from './finance.service';

@Controller('finance')
@TenantScoped()
@Roles('OWNER')
@RequiresBillingAccess()
export class FinanceController {
  constructor(
    private readonly financeService: FinanceService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get('summary')
  getSummary(
    @CurrentUser() user: AuthUser,
    @Query() query: FinancePeriodQueryDto,
  ) {
    return this.financeService.getSummary(
      this.accessPolicy.assertOwnerAccess(user),
      query,
    );
  }

  @Get('categories')
  listCategories(@CurrentUser() user: AuthUser) {
    return this.financeService.listCategories(
      this.accessPolicy.assertOwnerAccess(user),
    );
  }

  @Post('categories')
  createCategory(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateFinancialCategoryDto,
  ) {
    return this.financeService.createCategory(
      this.accessPolicy.assertOwnerAccess(user),
      dto,
    );
  }

  @Patch('categories/:id')
  updateCategory(
    @CurrentUser() user: AuthUser,
    @Param('id') categoryId: string,
    @Body() dto: UpdateFinancialCategoryDto,
  ) {
    return this.financeService.updateCategory(
      this.accessPolicy.assertOwnerAccess(user),
      categoryId,
      dto,
    );
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteCategory(
    @CurrentUser() user: AuthUser,
    @Param('id') categoryId: string,
  ) {
    return this.financeService.deleteCategory(
      this.accessPolicy.assertOwnerAccess(user),
      categoryId,
    );
  }

  @Get('transactions')
  listTransactions(
    @CurrentUser() user: AuthUser,
    @Query() query: ListFinancialTransactionsDto,
  ) {
    return this.financeService.listTransactions(
      this.accessPolicy.assertOwnerAccess(user),
      query,
    );
  }

  @Post('transactions')
  createTransaction(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateFinancialTransactionDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.financeService.createTransaction(clinicId, user.id, dto);
  }

  @Patch('transactions/:id')
  updateTransaction(
    @CurrentUser() user: AuthUser,
    @Param('id') transactionId: string,
    @Body() dto: UpdateFinancialTransactionDto,
  ) {
    return this.financeService.updateTransaction(
      this.accessPolicy.assertOwnerAccess(user),
      transactionId,
      dto,
    );
  }

  @Delete('transactions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteTransaction(
    @CurrentUser() user: AuthUser,
    @Param('id') transactionId: string,
  ) {
    return this.financeService.deleteTransaction(
      this.accessPolicy.assertOwnerAccess(user),
      transactionId,
    );
  }

  @Get('fixed-expenses')
  listFixedExpenses(@CurrentUser() user: AuthUser) {
    return this.financeService.listFixedExpenses(
      this.accessPolicy.assertOwnerAccess(user),
    );
  }

  @Post('fixed-expenses')
  createFixedExpense(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateFixedExpenseDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.financeService.createFixedExpense(clinicId, user.id, dto);
  }

  @Patch('fixed-expenses/:id')
  updateFixedExpense(
    @CurrentUser() user: AuthUser,
    @Param('id') fixedExpenseId: string,
    @Body() dto: UpdateFixedExpenseDto,
  ) {
    return this.financeService.updateFixedExpense(
      this.accessPolicy.assertOwnerAccess(user),
      fixedExpenseId,
      dto,
    );
  }

  @Delete('fixed-expenses/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteFixedExpense(
    @CurrentUser() user: AuthUser,
    @Param('id') fixedExpenseId: string,
  ) {
    return this.financeService.deleteFixedExpense(
      this.accessPolicy.assertOwnerAccess(user),
      fixedExpenseId,
    );
  }

  @Post('fixed-expenses/:id/generate')
  generateFixedExpenseOccurrence(
    @CurrentUser() user: AuthUser,
    @Param('id') fixedExpenseId: string,
    @Query('period') period?: string,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.financeService.generateFixedExpenseOccurrence(
      clinicId,
      user.id,
      fixedExpenseId,
      period,
    );
  }

  @Post('appointment-payments')
  createOrUpdateAppointmentPayment(
    @CurrentUser() user: AuthUser,
    @Body() dto: AppointmentPaymentDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.financeService.createOrUpdateAppointmentPayment(
      clinicId,
      user.id,
      dto,
    );
  }

  @Post('appointment-payments/:appointmentId/cancel')
  cancelAppointmentPayment(
    @CurrentUser() user: AuthUser,
    @Param('appointmentId') appointmentId: string,
  ) {
    return this.financeService.cancelAppointmentPayment(
      this.accessPolicy.assertOwnerAccess(user),
      appointmentId,
    );
  }
}
