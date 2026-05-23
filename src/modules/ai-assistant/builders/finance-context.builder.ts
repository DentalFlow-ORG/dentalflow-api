import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { FinanceService } from '../../finance/finance.service';

export type FinanceAiContext = {
  generatedAt: string;
  currency: 'BRL';
  period: { from: string; to: string };
  kpis: {
    totalIncome: number;
    totalExpenses: number;
    netProfit: number;
    profitMarginPercent: number;
    pendingReceivables: number;
    fixedExpensesTotal: number;
    overdueCount: number;
    overdueAmount: number;
  };
  expensesByCategory: Array<{
    categoryName: string;
    amount: number;
    sharePercent: number;
  }>;
  incomeByService: Array<{
    serviceName: string;
    amount: number;
    sharePercent: number;
  }>;
  limitations: string[];
};

@Injectable()
export class FinanceContextBuilder {
  constructor(
    private readonly financeService: FinanceService,
    private readonly prisma: PrismaService,
  ) {}

  async build(
    clinicId: string,
    from?: string,
    to?: string,
  ): Promise<FinanceAiContext> {
    const summary = await this.financeService.getSummary(clinicId, {
      from,
      to,
    });

    const today = new Date();
    today.setUTCHours(23, 59, 59, 999);

    const overdueAgg = await this.prisma.financialTransaction.aggregate({
      where: {
        clinicId,
        status: 'PENDING',
        dueDate: { lt: today, not: null },
      },
      _count: { id: true },
      _sum: { amount: true },
    });

    const { kpis, expensesByCategory, incomeByService, period } = summary;

    const limitations: string[] = [];
    if (kpis.totalIncome === 0 && kpis.totalExpenses === 0) {
      limitations.push('Nenhuma transação paga registrada no período.');
    }
    if (incomeByService.length === 0) {
      limitations.push('Sem dados de receita por serviço no período.');
    }
    if (kpis.pendingReceivables === 0 && overdueAgg._count.id === 0) {
      limitations.push('Sem pendências ou atrasos no período.');
    }

    return {
      generatedAt: new Date().toISOString(),
      currency: 'BRL',
      period: { from: period.from, to: period.to },
      kpis: {
        totalIncome: kpis.totalIncome,
        totalExpenses: kpis.totalExpenses,
        netProfit: kpis.netProfit,
        profitMarginPercent: Math.round(kpis.profitMargin * 10) / 10,
        pendingReceivables: kpis.pendingReceivables,
        fixedExpensesTotal: kpis.fixedExpensesTotal,
        overdueCount: overdueAgg._count.id,
        overdueAmount: Number(overdueAgg._sum.amount ?? 0),
      },
      expensesByCategory: expensesByCategory.slice(0, 5).map((item) => ({
        categoryName: item.categoryName,
        amount: item.amount,
        sharePercent:
          kpis.totalExpenses > 0
            ? Math.round((item.amount / kpis.totalExpenses) * 100)
            : 0,
      })),
      incomeByService: incomeByService.slice(0, 5).map((item) => ({
        serviceName: item.serviceName,
        amount: item.amount,
        sharePercent:
          kpis.totalIncome > 0
            ? Math.round((item.amount / kpis.totalIncome) * 100)
            : 0,
      })),
      limitations,
    };
  }
}
