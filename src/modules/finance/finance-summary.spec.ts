import { BadRequestException } from '@nestjs/common';
import {
  FinancialTransactionStatus as Status,
  FinancialTransactionType as Type,
  FixedExpenseRecurrence,
  Prisma,
} from '@prisma/client';

import { FinanceService } from './finance.service';
import { FinanceGroupByOption } from './dto/finance-query.dto';

/**
 * The finance summary: period resolution, aggregation and grouping.
 *
 * `finance.service.spec.ts` covers the write paths and their backend-owned
 * fields. This suite covers the reporting side, which is pure derivation over
 * transactions and therefore fails silently — a wrong total is just a wrong
 * number on a dashboard, with nothing thrown.
 *
 * Two rules run through all of it. Only PAID transactions count toward
 * realised money, with PENDING tracked separately as receivable or payable and
 * CANCELED excluded outright. And the default period is the current *Brazil*
 * month, not the UTC one, so the figures do not shift between 00:00 and 03:00
 * UTC.
 */

const CLINIC = 'clinic-1';

function tx(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    type: Type.INCOME,
    status: Status.PAID,
    amount: new Prisma.Decimal(100),
    transactionDate: new Date('2026-06-10T00:00:00.000Z'),
    category: null,
    service: null,
    ...overrides,
  };
}

function createPrisma() {
  return {
    financialTransaction: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    fixedExpense: { findMany: jest.fn().mockResolvedValue([]) },
    financialCategory: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  };
}

describe('FinanceService — summary and aggregation', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: FinanceService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    prisma = createPrisma();
    service = new FinanceService(prisma as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const summary = (query: Record<string, unknown> = {}) =>
    service.getSummary(CLINIC, query as never);

  const seed = (transactions: unknown[]) =>
    prisma.financialTransaction.findMany.mockResolvedValue(transactions);

  // ── Period resolution ──────────────────────────────────────────────────────

  describe('period', () => {
    it('defaults to the current Brazil month', async () => {
      await summary();

      const where = prisma.financialTransaction.findMany.mock.calls[0][0].where;
      expect(where.transactionDate.gte.toISOString()).toBe(
        '2026-06-01T00:00:00.000Z',
      );
      expect(where.transactionDate.lt.toISOString()).toBe(
        '2026-07-01T00:00:00.000Z',
      );
    });

    it('does not shift the default month during the 00:00–03:00 UTC window', async () => {
      // 01:00 UTC on 1 July is still June in Brazil, so June is the month a
      // clinic expects to see.
      jest.setSystemTime(new Date('2026-07-01T01:00:00.000Z'));

      await summary();

      const where = prisma.financialTransaction.findMany.mock.calls[0][0].where;
      expect(where.transactionDate.gte.toISOString()).toBe(
        '2026-06-01T00:00:00.000Z',
      );
    });

    it('honours an explicit range', async () => {
      await summary({ from: '2026-01-01', to: '2026-03-31' });

      const where = prisma.financialTransaction.findMany.mock.calls[0][0].where;
      expect(where.transactionDate.gte.toISOString()).toBe(
        '2026-01-01T00:00:00.000Z',
      );
      expect(where.transactionDate.lt.toISOString()).toBe(
        '2026-03-31T00:00:00.000Z',
      );
    });

    it('rejects a range that ends before it starts', async () => {
      await expect(
        summary({ from: '2026-06-30', to: '2026-06-01' }),
      ).rejects.toThrow(/nao pode ser maior/);
    });

    it('rejects an unparseable date', async () => {
      await expect(summary({ from: 'nao-e-data' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('accepts a range of a single day', async () => {
      await expect(
        summary({ from: '2026-06-10', to: '2026-06-10' }),
      ).resolves.toBeDefined();
    });

    it('excludes cancelled transactions from every figure', async () => {
      await summary();

      const where = prisma.financialTransaction.findMany.mock.calls[0][0].where;
      expect(where.status).toEqual({ not: Status.CANCELED });
    });

    it('scopes the query to the clinic', async () => {
      await summary();

      expect(
        prisma.financialTransaction.findMany.mock.calls[0][0].where.clinicId,
      ).toBe(CLINIC);
    });
  });

  // ── Totals ─────────────────────────────────────────────────────────────────

  describe('totals', () => {
    it('reports zeroes for a period with no activity', async () => {
      const result = await summary();

      expect(result.kpis).toMatchObject({
        totalIncome: 0,
        totalExpenses: 0,
        netProfit: 0,
        profitMargin: 0,
      });
    });

    it('counts only paid transactions as realised money', async () => {
      seed([
        tx({
          id: 'a',
          type: Type.INCOME,
          status: Status.PAID,
          amount: new Prisma.Decimal(1000),
        }),
        tx({
          id: 'b',
          type: Type.INCOME,
          status: Status.PENDING,
          amount: new Prisma.Decimal(500),
        }),
        tx({
          id: 'c',
          type: Type.EXPENSE,
          status: Status.PAID,
          amount: new Prisma.Decimal(300),
        }),
        tx({
          id: 'd',
          type: Type.EXPENSE,
          status: Status.PENDING,
          amount: new Prisma.Decimal(200),
        }),
      ]);

      const result = await summary();

      expect(result.kpis.totalIncome).toBe(1000);
      expect(result.kpis.totalExpenses).toBe(300);
      expect(result.kpis.netProfit).toBe(700);
    });

    it('tracks pending income as a receivable, apart from realised revenue', async () => {
      seed([
        tx({
          id: 'a',
          type: Type.INCOME,
          status: Status.PENDING,
          amount: new Prisma.Decimal(500),
        }),
        tx({
          id: 'b',
          type: Type.EXPENSE,
          status: Status.PENDING,
          amount: new Prisma.Decimal(200),
        }),
      ]);

      const result = await summary();

      expect(result.kpis.pendingReceivables).toBe(500);
      // …and neither pending row has touched the realised figures.
      expect(result.kpis.totalIncome).toBe(0);
      expect(result.kpis.netProfit).toBe(0);
    });

    it('reports the profit margin as a percentage of realised income', async () => {
      seed([
        tx({ id: 'a', type: Type.INCOME, amount: new Prisma.Decimal(1000) }),
        tx({ id: 'b', type: Type.EXPENSE, amount: new Prisma.Decimal(250) }),
      ]);

      expect((await summary()).kpis.profitMargin).toBe(75);
    });

    it('reports a zero margin rather than dividing by zero when there is no income', async () => {
      seed([
        tx({ id: 'b', type: Type.EXPENSE, amount: new Prisma.Decimal(250) }),
      ]);

      const result = await summary();
      expect(result.kpis.profitMargin).toBe(0);
      expect(Number.isFinite(result.kpis.profitMargin)).toBe(true);
    });

    it('totals the clinic’s active fixed expenses alongside the period figures', async () => {
      prisma.fixedExpense.findMany.mockResolvedValue([
        { amount: new Prisma.Decimal(1200) },
        { amount: new Prisma.Decimal(800) },
      ]);

      expect((await summary()).kpis.fixedExpensesTotal).toBe(2000);
    });

    it('reports a negative net profit when expenses exceed income', async () => {
      seed([
        tx({ id: 'a', type: Type.INCOME, amount: new Prisma.Decimal(100) }),
        tx({ id: 'b', type: Type.EXPENSE, amount: new Prisma.Decimal(400) }),
      ]);

      expect((await summary()).kpis.netProfit).toBe(-300);
    });

    it('sums decimal amounts without float drift', async () => {
      seed([
        tx({ id: 'a', amount: new Prisma.Decimal('0.10') }),
        tx({ id: 'b', amount: new Prisma.Decimal('0.20') }),
      ]);

      expect((await summary()).kpis.totalIncome).toBeCloseTo(0.3, 10);
    });
  });

  // ── Time series ────────────────────────────────────────────────────────────

  describe('time series', () => {
    it('groups by day by default', async () => {
      seed([
        tx({ id: 'a', transactionDate: new Date('2026-06-10T00:00:00.000Z') }),
        tx({ id: 'b', transactionDate: new Date('2026-06-11T00:00:00.000Z') }),
      ]);

      const result = await summary();

      expect(result.incomeVsExpenses.map((p) => p.date)).toEqual([
        '2026-06-10',
        '2026-06-11',
      ]);
    });

    it('combines several transactions on the same day', async () => {
      seed([
        tx({ id: 'a', amount: new Prisma.Decimal(100) }),
        tx({ id: 'b', amount: new Prisma.Decimal(50) }),
      ]);

      const result = await summary();

      expect(result.incomeVsExpenses).toHaveLength(1);
      expect(result.incomeVsExpenses[0].income).toBe(150);
    });

    it('groups by month when asked', async () => {
      seed([
        tx({ id: 'a', transactionDate: new Date('2026-06-03T00:00:00.000Z') }),
        tx({ id: 'b', transactionDate: new Date('2026-06-27T00:00:00.000Z') }),
      ]);

      const result = await summary({ groupBy: FinanceGroupByOption.MONTH });

      expect(result.incomeVsExpenses).toHaveLength(1);
      expect(result.incomeVsExpenses[0].date).toBe('2026-06-01');
    });

    it('groups by week, anchored to the Sunday', async () => {
      // 2026-06-10 is a Wednesday; its week starts Sunday 2026-06-07.
      seed([
        tx({ id: 'a', transactionDate: new Date('2026-06-10T00:00:00.000Z') }),
      ]);

      const result = await summary({ groupBy: FinanceGroupByOption.WEEK });

      expect(result.incomeVsExpenses[0].date).toBe('2026-06-07');
    });

    it('returns the series in date order regardless of input order', async () => {
      seed([
        tx({ id: 'a', transactionDate: new Date('2026-06-20T00:00:00.000Z') }),
        tx({ id: 'b', transactionDate: new Date('2026-06-05T00:00:00.000Z') }),
      ]);

      const result = await summary();

      expect(result.incomeVsExpenses.map((p) => p.date)).toEqual([
        '2026-06-05',
        '2026-06-20',
      ]);
    });

    it('carries the running net profit on each point', async () => {
      seed([
        tx({ id: 'a', type: Type.INCOME, amount: new Prisma.Decimal(300) }),
        tx({ id: 'b', type: Type.EXPENSE, amount: new Prisma.Decimal(100) }),
      ]);

      const result = await summary();

      expect(result.incomeVsExpenses[0]).toMatchObject({
        income: 300,
        expenses: 100,
        netProfit: 200,
      });
    });

    it('excludes pending transactions from the series', async () => {
      // The series shows cash that actually moved.
      seed([tx({ id: 'a', status: Status.PENDING })]);

      expect((await summary()).incomeVsExpenses).toEqual([]);
    });
  });

  // ── Expenses by category ───────────────────────────────────────────────────

  describe('expenses by category', () => {
    const category = (
      id: string,
      name: string,
      color: string | null = null,
    ) => ({
      id,
      name,
      color,
    });

    it('groups paid expenses by category', async () => {
      seed([
        tx({
          id: 'a',
          type: Type.EXPENSE,
          amount: new Prisma.Decimal(100),
          category: category('c1', 'Materiais'),
        }),
        tx({
          id: 'b',
          type: Type.EXPENSE,
          amount: new Prisma.Decimal(50),
          category: category('c1', 'Materiais'),
        }),
        tx({
          id: 'c',
          type: Type.EXPENSE,
          amount: new Prisma.Decimal(200),
          category: category('c2', 'Aluguel'),
        }),
      ]);

      const result = await summary();

      expect(result.expensesByCategory).toEqual([
        { categoryId: 'c2', categoryName: 'Aluguel', color: null, amount: 200 },
        {
          categoryId: 'c1',
          categoryName: 'Materiais',
          color: null,
          amount: 150,
        },
      ]);
    });

    it('orders categories by spend, largest first', async () => {
      seed([
        tx({
          id: 'a',
          type: Type.EXPENSE,
          amount: new Prisma.Decimal(10),
          category: category('c1', 'Pequena'),
        }),
        tx({
          id: 'b',
          type: Type.EXPENSE,
          amount: new Prisma.Decimal(900),
          category: category('c2', 'Grande'),
        }),
      ]);

      const result = await summary();
      expect(result.expensesByCategory[0].categoryName).toBe('Grande');
    });

    it('collects uncategorised spend under a single bucket', async () => {
      seed([
        tx({
          id: 'a',
          type: Type.EXPENSE,
          amount: new Prisma.Decimal(30),
          category: null,
        }),
        tx({
          id: 'b',
          type: Type.EXPENSE,
          amount: new Prisma.Decimal(20),
          category: null,
        }),
      ]);

      const result = await summary();

      expect(result.expensesByCategory).toEqual([
        {
          categoryId: null,
          categoryName: 'Sem categoria',
          color: null,
          amount: 50,
        },
      ]);
    });

    it('excludes income and unpaid expenses', async () => {
      seed([
        tx({ id: 'a', type: Type.INCOME, category: category('c1', 'Receita') }),
        tx({
          id: 'b',
          type: Type.EXPENSE,
          status: Status.PENDING,
          category: category('c2', 'Futura'),
        }),
      ]);

      expect((await summary()).expensesByCategory).toEqual([]);
    });

    it('carries the category colour through for the chart', async () => {
      seed([
        tx({
          id: 'a',
          type: Type.EXPENSE,
          category: category('c1', 'Materiais', '#ff0000'),
        }),
      ]);

      expect((await summary()).expensesByCategory[0].color).toBe('#ff0000');
    });
  });

  // ── Income by service ──────────────────────────────────────────────────────

  describe('income by service', () => {
    it('groups paid income by service', async () => {
      seed([
        tx({
          id: 'a',
          amount: new Prisma.Decimal(300),
          service: { id: 's1', name: 'Limpeza' },
        }),
        tx({
          id: 'b',
          amount: new Prisma.Decimal(200),
          service: { id: 's1', name: 'Limpeza' },
        }),
      ]);

      const result = await summary();

      expect(result.incomeByService).toEqual([
        { serviceId: 's1', serviceName: 'Limpeza', amount: 500 },
      ]);
    });

    it('labels income with no service as manual', async () => {
      seed([tx({ id: 'a', amount: new Prisma.Decimal(80), service: null })]);

      expect((await summary()).incomeByService).toEqual([
        { serviceId: null, serviceName: 'Receitas manuais', amount: 80 },
      ]);
    });

    it('orders services by revenue, largest first', async () => {
      seed([
        tx({
          id: 'a',
          amount: new Prisma.Decimal(10),
          service: { id: 's1', name: 'Pequeno' },
        }),
        tx({
          id: 'b',
          amount: new Prisma.Decimal(90),
          service: { id: 's2', name: 'Grande' },
        }),
      ]);

      expect((await summary()).incomeByService[0].serviceName).toBe('Grande');
    });

    it('excludes expenses and unpaid income', async () => {
      seed([
        tx({
          id: 'a',
          type: Type.EXPENSE,
          service: { id: 's1', name: 'Despesa' },
        }),
        tx({
          id: 'b',
          status: Status.PENDING,
          service: { id: 's2', name: 'Futura' },
        }),
      ]);

      expect((await summary()).incomeByService).toEqual([]);
    });
  });

  // ── Fixed expenses ─────────────────────────────────────────────────────────

  describe('fixed expenses', () => {
    it('considers only active fixed expenses', async () => {
      await summary();

      expect(prisma.fixedExpense.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
        isActive: true,
      });
    });
  });

  // ── Due-date resolution for recurring expenses ─────────────────────────────

  describe('fixed expense due dates', () => {
    const dueDate = (
      dueDay: number,
      recurrence: FixedExpenseRecurrence,
      period?: string,
    ) =>
      (
        service as unknown as {
          resolveFixedExpenseDueDate(
            d: number,
            r: FixedExpenseRecurrence,
            p?: string,
          ): Date;
        }
      ).resolveFixedExpenseDueDate(dueDay, recurrence, period);

    it('places a monthly expense on its due day', () => {
      expect(
        dueDate(10, FixedExpenseRecurrence.MONTHLY, '2026-06').toISOString(),
      ).toBe('2026-06-10T00:00:00.000Z');
    });

    it('clamps a due day past the end of a short month', () => {
      // Rent due on the 31st still falls due in February.
      expect(
        dueDate(31, FixedExpenseRecurrence.MONTHLY, '2026-02').toISOString(),
      ).toBe('2026-02-28T00:00:00.000Z');
    });

    it('handles a leap February', () => {
      expect(
        dueDate(31, FixedExpenseRecurrence.MONTHLY, '2028-02').toISOString(),
      ).toBe('2028-02-29T00:00:00.000Z');
    });

    it('anchors a yearly expense to January', () => {
      expect(
        dueDate(15, FixedExpenseRecurrence.YEARLY, '2026-06').toISOString(),
      ).toBe('2026-01-15T00:00:00.000Z');
    });

    it('offsets a weekly expense from the start of the period', () => {
      expect(
        dueDate(3, FixedExpenseRecurrence.WEEKLY, '2026-06').toISOString(),
      ).toBe('2026-06-03T00:00:00.000Z');
    });

    it('treats day 1 of a weekly expense as the period start itself', () => {
      expect(
        dueDate(1, FixedExpenseRecurrence.WEEKLY, '2026-06').toISOString(),
      ).toBe('2026-06-01T00:00:00.000Z');
    });
  });

  // ── Paid-at resolution ─────────────────────────────────────────────────────

  describe('paidAt resolution', () => {
    const paidAt = (status: Status, value?: string | null) =>
      (
        service as unknown as {
          resolvePaidAt(s: Status, v?: string | null): Date | null;
        }
      ).resolvePaidAt(status, value);

    it('stamps now when a transaction is created already paid', () => {
      expect(paidAt(Status.PAID)).toBeInstanceOf(Date);
    });

    it('leaves a pending transaction unpaid', () => {
      expect(paidAt(Status.PENDING)).toBeNull();
    });

    it('honours an explicit payment date', () => {
      expect(
        paidAt(Status.PAID, '2026-06-10T00:00:00.000Z')?.toISOString(),
      ).toBe('2026-06-10T00:00:00.000Z');
    });

    it('clears the payment date when explicitly set to null', () => {
      // Distinct from "not supplied": null means un-pay this transaction.
      expect(paidAt(Status.PAID, null)).toBeNull();
    });

    it('rejects an unparseable payment date', () => {
      expect(() => paidAt(Status.PAID, 'ontem')).toThrow(BadRequestException);
    });
  });
});
