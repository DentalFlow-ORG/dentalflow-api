import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FinancialTransactionSource,
  FinancialTransactionStatus,
  FinancialTransactionType,
  FixedExpenseRecurrence,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  brazilCurrentIsoMonth,
} from '../../common/utils/brazil-timezone';
import { AppointmentPaymentDto } from './dto/appointment-payment.dto';
import { CreateFinancialCategoryDto } from './dto/create-financial-category.dto';
import { CreateFinancialTransactionDto } from './dto/create-financial-transaction.dto';
import { CreateFixedExpenseDto } from './dto/create-fixed-expense.dto';
import {
  FinanceGroupByOption,
  FinancePeriodQueryDto,
  ListFinancialTransactionsDto,
} from './dto/finance-query.dto';
import { UpdateFinancialCategoryDto } from './dto/update-financial-category.dto';
import { UpdateFinancialTransactionDto } from './dto/update-financial-transaction.dto';
import { UpdateFixedExpenseDto } from './dto/update-fixed-expense.dto';

type FinanceGroupBy = FinanceGroupByOption;

const defaultCategories = [
  {
    name: 'Servicos odontologicos',
    type: FinancialTransactionType.INCOME,
    color: '#10B981',
    icon: 'stethoscope',
  },
  {
    name: 'Receitas manuais',
    type: FinancialTransactionType.INCOME,
    color: '#6366F1',
    icon: 'plus-circle',
  },
  {
    name: 'Aluguel',
    type: FinancialTransactionType.EXPENSE,
    color: '#F97316',
    icon: 'building',
  },
  {
    name: 'Salarios',
    type: FinancialTransactionType.EXPENSE,
    color: '#EF4444',
    icon: 'users',
  },
  {
    name: 'Materiais',
    type: FinancialTransactionType.EXPENSE,
    color: '#F59E0B',
    icon: 'package',
  },
  {
    name: 'Impostos',
    type: FinancialTransactionType.EXPENSE,
    color: '#7C3AED',
    icon: 'receipt',
  },
  {
    name: 'Software e ferramentas',
    type: FinancialTransactionType.EXPENSE,
    color: '#0EA5E9',
    icon: 'monitor',
  },
  {
    name: 'Despesas manuais',
    type: FinancialTransactionType.EXPENSE,
    color: '#64748B',
    icon: 'minus-circle',
  },
] as const;

@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(clinicId: string, query: FinancePeriodQueryDto) {
    const period = this.resolvePeriod(query);
    const transactions = await this.prisma.financialTransaction.findMany({
      where: {
        clinicId,
        transactionDate: {
          gte: period.from,
          lt: period.to,
        },
        status: {
          not: FinancialTransactionStatus.CANCELED,
        },
      },
      include: {
        category: true,
        service: true,
      },
      orderBy: { transactionDate: 'asc' },
    });

    const fixedExpenses = await this.prisma.fixedExpense.findMany({
      where: { clinicId, isActive: true },
    });

    const paidIncome = this.sumTransactions(
      transactions,
      FinancialTransactionType.INCOME,
      FinancialTransactionStatus.PAID,
    );
    const paidExpenses = this.sumTransactions(
      transactions,
      FinancialTransactionType.EXPENSE,
      FinancialTransactionStatus.PAID,
    );
    const pendingReceivables = this.sumTransactions(
      transactions,
      FinancialTransactionType.INCOME,
      FinancialTransactionStatus.PENDING,
    );
    const fixedExpensesTotal = fixedExpenses.reduce(
      (total, expense) => total + this.toNumber(expense.amount),
      0,
    );
    const netProfit = paidIncome - paidExpenses;

    return {
      period: {
        from: this.formatDate(period.from),
        to: this.formatDate(period.to),
        groupBy: period.groupBy,
      },
      kpis: {
        totalIncome: paidIncome,
        totalExpenses: paidExpenses,
        netProfit,
        profitMargin: paidIncome > 0 ? (netProfit / paidIncome) * 100 : 0,
        pendingReceivables,
        fixedExpensesTotal,
      },
      incomeVsExpenses: this.buildTimeSeries(transactions, period.groupBy),
      expensesByCategory: this.groupExpensesByCategory(transactions),
      incomeByService: this.groupIncomeByService(transactions),
    };
  }

  async listCategories(clinicId: string) {
    await this.ensureDefaultCategories(clinicId);

    return this.prisma.financialCategory.findMany({
      where: { clinicId },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  }

  async createCategory(clinicId: string, dto: CreateFinancialCategoryDto) {
    return this.prisma.financialCategory.create({
      data: {
        clinicId,
        name: dto.name,
        type: dto.type,
        color: dto.color,
        icon: dto.icon,
        isDefault: false,
      },
    });
  }

  async updateCategory(
    clinicId: string,
    categoryId: string,
    dto: UpdateFinancialCategoryDto,
  ) {
    await this.assertCategory(clinicId, categoryId);

    return this.prisma.financialCategory.update({
      where: { id: categoryId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
      },
    });
  }

  async deleteCategory(clinicId: string, categoryId: string) {
    const category = await this.assertCategory(clinicId, categoryId);
    if (category.isDefault) {
      throw new ConflictException('Categorias padrao nao podem ser removidas.');
    }

    const usageCount = await this.prisma.financialTransaction.count({
      where: { clinicId, categoryId },
    });
    const fixedExpenseCount = await this.prisma.fixedExpense.count({
      where: { clinicId, categoryId },
    });

    if (usageCount > 0 || fixedExpenseCount > 0) {
      throw new ConflictException(
        'Esta categoria ja possui movimentacoes vinculadas.',
      );
    }

    await this.prisma.financialCategory.delete({ where: { id: categoryId } });
  }

  async listTransactions(clinicId: string, query: ListFinancialTransactionsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const period = this.resolvePeriod(query);
    const where: Prisma.FinancialTransactionWhereInput = {
      clinicId,
      transactionDate: {
        gte: period.from,
        lte: period.to,
      },
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.financialTransaction.findMany({
        where,
        include: {
          category: true,
          service: true,
          profile: true,
          appointment: true,
        },
        orderBy: [{ transactionDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.financialTransaction.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async createTransaction(
    clinicId: string,
    createdByUserId: string,
    dto: CreateFinancialTransactionDto,
  ) {
    await this.assertCategory(clinicId, dto.categoryId, dto.type);
    const status = dto.status ?? FinancialTransactionStatus.PENDING;

    return this.prisma.financialTransaction.create({
      data: {
        clinicId,
        type: dto.type,
        source: FinancialTransactionSource.MANUAL,
        categoryId: dto.categoryId,
        amount: this.toDecimal(dto.amount),
        description: dto.description,
        transactionDate: this.parseDate(dto.transactionDate, 'Data da movimentacao'),
        dueDate: this.parseOptionalDate(dto.dueDate, 'Data de vencimento'),
        paidAt: this.resolvePaidAt(status, dto.paidAt),
        status,
        createdByUserId,
      },
    });
  }

  async updateTransaction(
    clinicId: string,
    transactionId: string,
    dto: UpdateFinancialTransactionDto,
  ) {
    const transaction = await this.assertTransaction(clinicId, transactionId);
    const type = dto.type ?? transaction.type;

    if (dto.categoryId) {
      await this.assertCategory(clinicId, dto.categoryId, type);
    }

    const status = dto.status ?? transaction.status;

    return this.prisma.financialTransaction.update({
      where: { id: transactionId },
      data: {
        ...(dto.type ? { type: dto.type } : {}),
        ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
        ...(dto.amount ? { amount: this.toDecimal(dto.amount) } : {}),
        ...(dto.description ? { description: dto.description } : {}),
        ...(dto.transactionDate
          ? {
              transactionDate: this.parseDate(
                dto.transactionDate,
                'Data da movimentacao',
              ),
            }
          : {}),
        ...(dto.dueDate !== undefined
          ? { dueDate: this.parseOptionalDate(dto.dueDate, 'Data de vencimento') }
          : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.paidAt !== undefined
          ? { paidAt: this.resolvePaidAt(status, dto.paidAt) }
          : {}),
      },
    });
  }

  async deleteTransaction(clinicId: string, transactionId: string) {
    await this.assertTransaction(clinicId, transactionId);

    await this.prisma.financialTransaction.update({
      where: { id: transactionId },
      data: { status: FinancialTransactionStatus.CANCELED },
    });
  }

  async listFixedExpenses(clinicId: string) {
    return this.prisma.fixedExpense.findMany({
      where: { clinicId },
      include: { category: true },
      orderBy: [{ isActive: 'desc' }, { dueDay: 'asc' }],
    });
  }

  async createFixedExpense(
    clinicId: string,
    createdByUserId: string,
    dto: CreateFixedExpenseDto,
  ) {
    await this.assertCategory(
      clinicId,
      dto.categoryId,
      FinancialTransactionType.EXPENSE,
    );

    return this.prisma.fixedExpense.create({
      data: {
        clinicId,
        categoryId: dto.categoryId,
        description: dto.description,
        amount: this.toDecimal(dto.amount),
        recurrence: dto.recurrence,
        dueDay: dto.dueDay,
        startDate: this.parseDate(dto.startDate, 'Data inicial'),
        endDate: this.parseOptionalDate(dto.endDate, 'Data final'),
        isActive: dto.isActive ?? true,
        createdByUserId,
      },
    });
  }

  async updateFixedExpense(
    clinicId: string,
    fixedExpenseId: string,
    dto: UpdateFixedExpenseDto,
  ) {
    await this.assertFixedExpense(clinicId, fixedExpenseId);

    if (dto.categoryId) {
      await this.assertCategory(
        clinicId,
        dto.categoryId,
        FinancialTransactionType.EXPENSE,
      );
    }

    return this.prisma.fixedExpense.update({
      where: { id: fixedExpenseId },
      data: {
        ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
        ...(dto.description ? { description: dto.description } : {}),
        ...(dto.amount ? { amount: this.toDecimal(dto.amount) } : {}),
        ...(dto.recurrence ? { recurrence: dto.recurrence } : {}),
        ...(dto.dueDay ? { dueDay: dto.dueDay } : {}),
        ...(dto.startDate
          ? { startDate: this.parseDate(dto.startDate, 'Data inicial') }
          : {}),
        ...(dto.endDate !== undefined
          ? { endDate: this.parseOptionalDate(dto.endDate, 'Data final') }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  async deleteFixedExpense(clinicId: string, fixedExpenseId: string) {
    await this.assertFixedExpense(clinicId, fixedExpenseId);

    await this.prisma.fixedExpense.update({
      where: { id: fixedExpenseId },
      data: { isActive: false },
    });
  }

  async generateFixedExpenseOccurrence(
    clinicId: string,
    createdByUserId: string,
    fixedExpenseId: string,
    period?: string,
  ) {
    const fixedExpense = await this.assertFixedExpense(clinicId, fixedExpenseId);
    if (!fixedExpense.isActive) {
      throw new ConflictException('Despesa fixa inativa nao pode gerar lancamento.');
    }

    const dueDate = this.resolveFixedExpenseDueDate(
      fixedExpense.dueDay,
      fixedExpense.recurrence,
      period,
    );

    return this.prisma.financialTransaction.upsert({
      where: {
        clinicId_fixedExpenseId_dueDate: {
          clinicId,
          fixedExpenseId,
          dueDate,
        },
      },
      create: {
        clinicId,
        type: FinancialTransactionType.EXPENSE,
        source: FinancialTransactionSource.FIXED_EXPENSE,
        categoryId: fixedExpense.categoryId,
        fixedExpenseId,
        amount: fixedExpense.amount,
        description: fixedExpense.description,
        transactionDate: dueDate,
        dueDate,
        status: FinancialTransactionStatus.PENDING,
        createdByUserId,
      },
      update: {
        categoryId: fixedExpense.categoryId,
        amount: fixedExpense.amount,
        description: fixedExpense.description,
      },
    });
  }

  async createOrUpdateAppointmentPayment(
    clinicId: string,
    createdByUserId: string,
    dto: AppointmentPaymentDto,
  ) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: dto.appointmentId, clinicId },
      include: {
        service: true,
        profile: true,
      },
    });

    if (!appointment) {
      throw new NotFoundException('Agendamento nao encontrado.');
    }

    const categoryId =
      dto.categoryId ??
      (await this.getDefaultCategoryId(
        clinicId,
        FinancialTransactionType.INCOME,
        'Servicos odontologicos',
      ));
    await this.assertCategory(
      clinicId,
      categoryId,
      FinancialTransactionType.INCOME,
    );

    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) {
      throw new BadRequestException('Data de pagamento invalida.');
    }

    const description =
      dto.description ??
      `Pagamento de ${appointment.service?.name ?? 'servico'} - ${appointment.patientName}`;

    return this.prisma.financialTransaction.upsert({
      where: {
        clinicId_appointmentId_source: {
          clinicId,
          appointmentId: dto.appointmentId,
          source: FinancialTransactionSource.SERVICE_PAYMENT,
        },
      },
      create: {
        clinicId,
        type: FinancialTransactionType.INCOME,
        source: FinancialTransactionSource.SERVICE_PAYMENT,
        categoryId,
        amount: this.toDecimal(dto.amount),
        description,
        transactionDate: this.dateOnly(paidAt),
        paidAt,
        status: FinancialTransactionStatus.PAID,
        appointmentId: appointment.id,
        serviceId: appointment.serviceId,
        profileId: appointment.profileId,
        createdByUserId,
      },
      update: {
        categoryId,
        amount: this.toDecimal(dto.amount),
        description,
        transactionDate: this.dateOnly(paidAt),
        paidAt,
        status: FinancialTransactionStatus.PAID,
        serviceId: appointment.serviceId,
        profileId: appointment.profileId,
      },
    });
  }

  async cancelAppointmentPayment(clinicId: string, appointmentId: string) {
    const transaction = await this.prisma.financialTransaction.findFirst({
      where: {
        clinicId,
        appointmentId,
        source: FinancialTransactionSource.SERVICE_PAYMENT,
      },
    });

    if (!transaction) {
      throw new NotFoundException('Lancamento financeiro nao encontrado.');
    }

    return this.prisma.financialTransaction.update({
      where: { id: transaction.id },
      data: { status: FinancialTransactionStatus.CANCELED },
    });
  }

  private async ensureDefaultCategories(clinicId: string) {
    await this.prisma.financialCategory.createMany({
      data: defaultCategories.map((category) => ({
        clinicId,
        ...category,
        isDefault: true,
      })),
      skipDuplicates: true,
    });
  }

  private async getDefaultCategoryId(
    clinicId: string,
    type: FinancialTransactionType,
    name: string,
  ) {
    await this.ensureDefaultCategories(clinicId);
    const category = await this.prisma.financialCategory.findFirst({
      where: { clinicId, type, name },
    });

    if (!category) {
      throw new NotFoundException('Categoria padrao nao encontrada.');
    }

    return category.id;
  }

  private async assertCategory(
    clinicId: string,
    categoryId: string,
    type?: FinancialTransactionType,
  ) {
    const category = await this.prisma.financialCategory.findFirst({
      where: {
        id: categoryId,
        clinicId,
        ...(type ? { type } : {}),
      },
    });

    if (!category) {
      throw new NotFoundException('Categoria financeira nao encontrada.');
    }

    return category;
  }

  private async assertTransaction(clinicId: string, transactionId: string) {
    const transaction = await this.prisma.financialTransaction.findFirst({
      where: { id: transactionId, clinicId },
    });

    if (!transaction) {
      throw new NotFoundException('Movimentacao financeira nao encontrada.');
    }

    return transaction;
  }

  private async assertFixedExpense(clinicId: string, fixedExpenseId: string) {
    const fixedExpense = await this.prisma.fixedExpense.findFirst({
      where: { id: fixedExpenseId, clinicId },
    });

    if (!fixedExpense) {
      throw new NotFoundException('Despesa fixa nao encontrada.');
    }

    return fixedExpense;
  }

  private resolvePeriod(query: FinancePeriodQueryDto) {
    // transactionDate is stored as UTC midnight, so use UTC midnight boundaries.
    // The default month must be derived from the Brazil calendar, not UTC, so the
    // window doesn't shift during 00:00-03:00 UTC.
    const [bmy, bmm] = brazilCurrentIsoMonth().split('-').map(Number);
    const from = query.from
      ? this.parseDate(query.from, 'Data inicial')
      : new Date(Date.UTC(bmy, bmm - 1, 1));
    const to = query.to
      ? this.parseDate(query.to, 'Data final')
      : new Date(Date.UTC(bmy, bmm, 1));

    if (from > to) {
      throw new BadRequestException('Data inicial nao pode ser maior que a final.');
    }

    return {
      from,
      to,
      groupBy: query.groupBy ?? FinanceGroupByOption.DAY,
    };
  }

  private parseDate(value: string, fieldName: string) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${fieldName} invalida.`);
    }

    return date;
  }

  private parseOptionalDate(value: string | undefined, fieldName: string) {
    if (!value) {
      return null;
    }

    return this.parseDate(value, fieldName);
  }

  private resolvePaidAt(
    status: FinancialTransactionStatus,
    value?: string | null,
  ) {
    if (value === null) {
      return null;
    }

    if (value) {
      const paidAt = new Date(value);
      if (Number.isNaN(paidAt.getTime())) {
        throw new BadRequestException('Data de pagamento invalida.');
      }

      return paidAt;
    }

    return status === FinancialTransactionStatus.PAID ? new Date() : null;
  }

  private resolveFixedExpenseDueDate(
    dueDay: number,
    recurrence: FixedExpenseRecurrence,
    period?: string,
  ) {
    const base = period ? this.parseDate(`${period}-01`, 'Periodo') : new Date();

    if (recurrence === FixedExpenseRecurrence.WEEKLY) {
      const start = this.dateOnly(base);
      start.setUTCDate(start.getUTCDate() + Math.max(0, dueDay - 1));
      return start;
    }

    const month = recurrence === FixedExpenseRecurrence.YEARLY ? 0 : base.getUTCMonth();
    const year = base.getUTCFullYear();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

    return new Date(Date.UTC(year, month, Math.min(dueDay, lastDay)));
  }

  private toDecimal(amount: number) {
    return new Prisma.Decimal(amount).toDecimalPlaces(2);
  }

  private toNumber(value: Prisma.Decimal | number | string) {
    return Number(value);
  }

  private sumTransactions(
    transactions: Array<{
      type: FinancialTransactionType;
      status: FinancialTransactionStatus;
      amount: Prisma.Decimal;
    }>,
    type: FinancialTransactionType,
    status: FinancialTransactionStatus,
  ) {
    return transactions
      .filter((transaction) => transaction.type === type && transaction.status === status)
      .reduce((total, transaction) => total + this.toNumber(transaction.amount), 0);
  }

  private buildTimeSeries(
    transactions: Array<{
      transactionDate: Date;
      type: FinancialTransactionType;
      status: FinancialTransactionStatus;
      amount: Prisma.Decimal;
    }>,
    groupBy: FinanceGroupBy,
  ) {
    const grouped = new Map<
      string,
      { date: string; income: number; expenses: number; netProfit: number }
    >();

    transactions
      .filter((transaction) => transaction.status === FinancialTransactionStatus.PAID)
      .forEach((transaction) => {
        const key = this.groupDate(transaction.transactionDate, groupBy);
        const current = grouped.get(key) ?? {
          date: key,
          income: 0,
          expenses: 0,
          netProfit: 0,
        };
        const amount = this.toNumber(transaction.amount);

        if (transaction.type === FinancialTransactionType.INCOME) {
          current.income += amount;
        } else {
          current.expenses += amount;
        }

        current.netProfit = current.income - current.expenses;
        grouped.set(key, current);
      });

    return [...grouped.values()].sort((left, right) =>
      left.date.localeCompare(right.date),
    );
  }

  private groupExpensesByCategory(
    transactions: Array<{
      category: { id: string; name: string; color: string | null } | null;
      type: FinancialTransactionType;
      status: FinancialTransactionStatus;
      amount: Prisma.Decimal;
    }>,
  ) {
    const grouped = new Map<
      string,
      { categoryId: string | null; categoryName: string; color: string | null; amount: number }
    >();

    transactions
      .filter(
        (transaction) =>
          transaction.type === FinancialTransactionType.EXPENSE &&
          transaction.status === FinancialTransactionStatus.PAID,
      )
      .forEach((transaction) => {
        const key = transaction.category?.id ?? 'uncategorized';
        const current = grouped.get(key) ?? {
          categoryId: transaction.category?.id ?? null,
          categoryName: transaction.category?.name ?? 'Sem categoria',
          color: transaction.category?.color ?? null,
          amount: 0,
        };

        current.amount += this.toNumber(transaction.amount);
        grouped.set(key, current);
      });

    return [...grouped.values()].sort((left, right) => right.amount - left.amount);
  }

  private groupIncomeByService(
    transactions: Array<{
      service: { id: string; name: string } | null;
      type: FinancialTransactionType;
      status: FinancialTransactionStatus;
      amount: Prisma.Decimal;
    }>,
  ) {
    const grouped = new Map<
      string,
      { serviceId: string | null; serviceName: string; amount: number }
    >();

    transactions
      .filter(
        (transaction) =>
          transaction.type === FinancialTransactionType.INCOME &&
          transaction.status === FinancialTransactionStatus.PAID,
      )
      .forEach((transaction) => {
        const key = transaction.service?.id ?? 'manual';
        const current = grouped.get(key) ?? {
          serviceId: transaction.service?.id ?? null,
          serviceName: transaction.service?.name ?? 'Receitas manuais',
          amount: 0,
        };

        current.amount += this.toNumber(transaction.amount);
        grouped.set(key, current);
      });

    return [...grouped.values()].sort((left, right) => right.amount - left.amount);
  }

  private groupDate(date: Date, groupBy: FinanceGroupBy) {
    const grouped = this.dateOnly(date);

    if (groupBy === FinanceGroupByOption.MONTH) {
      grouped.setUTCDate(1);
    }

    if (groupBy === FinanceGroupByOption.WEEK) {
      const day = grouped.getUTCDay();
      grouped.setUTCDate(grouped.getUTCDate() - day);
    }

    return this.formatDate(grouped);
  }

  private dateOnly(date: Date) {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  private formatDate(date: Date) {
    return date.toISOString().slice(0, 10);
  }
}
