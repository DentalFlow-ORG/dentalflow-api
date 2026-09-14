import { Prisma } from '@prisma/client';

import { FinanceContextBuilder } from './finance-context.builder';
import { InventoryContextBuilder } from './inventory-context.builder';

/**
 * The two context builders: what the AI assistant is allowed to see.
 *
 * These decide the entire input to a third-party model, so they are the last
 * place a clinic's data is under our control. Two things follow. The context
 * must be aggregate — counts, totals and product names, never a patient — and
 * it must say what it does *not* know, because a model handed a silent zero
 * will explain the zero rather than report the gap.
 *
 * Both also cap what they send: five categories, ten critical products. An
 * uncapped context grows with the clinic until it no longer fits in a prompt.
 */

const CLINIC = 'clinic-1';
const FROZEN_NOW = new Date('2026-06-15T12:00:00.000Z');

function summaryFixture(overrides: Record<string, unknown> = {}) {
  return {
    period: { from: '2026-06-01', to: '2026-06-30' },
    kpis: {
      totalIncome: 100_000,
      totalExpenses: 40_000,
      netProfit: 60_000,
      profitMargin: 60.05,
      pendingReceivables: 5_000,
      fixedExpensesTotal: 10_000,
    },
    expensesByCategory: [{ categoryName: 'Aluguel', amount: 20_000 }],
    incomeByService: [{ serviceName: 'Limpeza', amount: 50_000 }],
    ...overrides,
  };
}

describe('FinanceContextBuilder', () => {
  let finance: { getSummary: jest.Mock };
  let prisma: { financialTransaction: { aggregate: jest.Mock } };
  let builder: FinanceContextBuilder;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(FROZEN_NOW);
    finance = { getSummary: jest.fn().mockResolvedValue(summaryFixture()) };
    prisma = {
      financialTransaction: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _count: { id: 0 }, _sum: { amount: null } }),
      },
    };
    builder = new FinanceContextBuilder(finance as never, prisma as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes the requested period through to the summary', async () => {
    await builder.build(CLINIC, '2026-06-01', '2026-06-30');

    expect(finance.getSummary).toHaveBeenCalledWith(CLINIC, {
      from: '2026-06-01',
      to: '2026-06-30',
    });
  });

  it('reports the KPIs the summary produced', async () => {
    const context = await builder.build(CLINIC);

    expect(context.kpis).toMatchObject({
      totalIncome: 100_000,
      totalExpenses: 40_000,
      netProfit: 60_000,
      pendingReceivables: 5_000,
      fixedExpensesTotal: 10_000,
    });
    expect(context.currency).toBe('BRL');
  });

  it('rounds the margin to one decimal place', async () => {
    const context = await builder.build(CLINIC);

    expect(context.kpis.profitMarginPercent).toBe(60.1);
  });

  it('counts only overdue receivables, scoped to the clinic', async () => {
    await builder.build(CLINIC);

    const where = prisma.financialTransaction.aggregate.mock.calls[0][0]
      .where as { clinicId: string; status: string; dueDate: { lt: Date } };
    expect(where.clinicId).toBe(CLINIC);
    expect(where.status).toBe('PENDING');
    // The whole of today counts as not-yet-overdue.
    expect(where.dueDate.lt.toISOString()).toBe('2026-06-15T23:59:59.999Z');
  });

  it('reports the overdue total the aggregate returned', async () => {
    prisma.financialTransaction.aggregate.mockResolvedValue({
      _count: { id: 3 },
      _sum: { amount: new Prisma.Decimal('1234.56') },
    });

    const context = await builder.build(CLINIC);

    expect(context.kpis.overdueCount).toBe(3);
    expect(context.kpis.overdueAmount).toBe(1234.56);
  });

  it('reports zero rather than null when nothing is overdue', async () => {
    const context = await builder.build(CLINIC);

    expect(context.kpis.overdueAmount).toBe(0);
  });

  it('expresses each expense category as a share of the total', async () => {
    finance.getSummary.mockResolvedValue(
      summaryFixture({
        expensesByCategory: [
          { categoryName: 'Aluguel', amount: 20_000 },
          { categoryName: 'Materiais', amount: 10_000 },
        ],
      }),
    );

    const context = await builder.build(CLINIC);

    expect(context.expensesByCategory).toEqual([
      { categoryName: 'Aluguel', amount: 20_000, sharePercent: 50 },
      { categoryName: 'Materiais', amount: 10_000, sharePercent: 25 },
    ]);
  });

  it('reports a zero share rather than dividing by zero', async () => {
    finance.getSummary.mockResolvedValue(
      summaryFixture({
        kpis: { ...summaryFixture().kpis, totalExpenses: 0, totalIncome: 0 },
      }),
    );

    const context = await builder.build(CLINIC);

    expect(context.expensesByCategory[0].sharePercent).toBe(0);
    expect(context.incomeByService[0].sharePercent).toBe(0);
  });

  it('sends at most five categories and five services', async () => {
    const many = (prefix: string) =>
      Array.from({ length: 9 }, (_, i) => ({
        categoryName: `${prefix}-${i}`,
        serviceName: `${prefix}-${i}`,
        amount: 1_000,
      }));
    finance.getSummary.mockResolvedValue(
      summaryFixture({
        expensesByCategory: many('cat'),
        incomeByService: many('svc'),
      }),
    );

    const context = await builder.build(CLINIC);

    // An uncapped context grows with the clinic until the prompt no longer
    // fits.
    expect(context.expensesByCategory).toHaveLength(5);
    expect(context.incomeByService).toHaveLength(5);
  });

  describe('what it admits not knowing', () => {
    it('says so when the period holds no paid transaction', async () => {
      finance.getSummary.mockResolvedValue(
        summaryFixture({
          kpis: { ...summaryFixture().kpis, totalIncome: 0, totalExpenses: 0 },
        }),
      );

      const context = await builder.build(CLINIC);

      // Without this the model explains a zero instead of reporting a gap.
      expect(context.limitations).toContain(
        'Nenhuma transação paga registrada no período.',
      );
    });

    it('says so when no revenue is attributed to a service', async () => {
      finance.getSummary.mockResolvedValue(
        summaryFixture({ incomeByService: [] }),
      );

      const context = await builder.build(CLINIC);

      expect(context.limitations).toContain(
        'Sem dados de receita por serviço no período.',
      );
    });

    it('says so when there is nothing pending or overdue', async () => {
      finance.getSummary.mockResolvedValue(
        summaryFixture({
          kpis: { ...summaryFixture().kpis, pendingReceivables: 0 },
        }),
      );

      const context = await builder.build(CLINIC);

      expect(context.limitations).toContain(
        'Sem pendências ou atrasos no período.',
      );
    });

    it('lists nothing when the period is fully populated', async () => {
      const context = await builder.build(CLINIC);

      expect(context.limitations).toEqual([]);
    });
  });

  it('carries no patient-identifying data', async () => {
    const context = await builder.build(CLINIC);

    // The context is the entire input to a third-party model.
    const serialised = JSON.stringify(context);
    expect(serialised).not.toMatch(/patient/i);
    expect(serialised).not.toMatch(/@/);
  });
});

// ── Inventory ────────────────────────────────────────────────────────────────

function stockRow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Anestésico',
    unit: 'CX',
    isActive: true,
    currentQuantity: new Prisma.Decimal(10),
    minQuantity: new Prisma.Decimal(2),
    expiresAt: null,
    category: { name: 'Anestésicos' },
    ...overrides,
  };
}

describe('InventoryContextBuilder', () => {
  let stock: { getSummary: jest.Mock };
  let prisma: { stockProduct: { findMany: jest.Mock } };
  let builder: InventoryContextBuilder;

  const summary = {
    totalActive: 4,
    lowStock: 1,
    emptyStock: 1,
    expiring: 0,
    expired: 0,
    inactive: 0,
    estimatedValue: 1_000,
    totalCategories: 2,
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(FROZEN_NOW);
    stock = { getSummary: jest.fn().mockResolvedValue(summary) };
    prisma = { stockProduct: { findMany: jest.fn().mockResolvedValue([]) } };
    builder = new InventoryContextBuilder(stock as never, prisma as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reads only the clinic’s active products', async () => {
    await builder.build(CLINIC);

    expect(prisma.stockProduct.findMany.mock.calls[0][0].where).toEqual({
      clinicId: CLINIC,
      isActive: true,
    });
  });

  it('passes the stock summary straight through', async () => {
    const context = await builder.build(CLINIC);

    expect(context.summary).toEqual(summary);
    expect(context.currency).toBe('BRL');
  });

  it('lists only products that need attention', async () => {
    prisma.stockProduct.findMany.mockResolvedValue([
      stockRow({ name: 'Saudável', currentQuantity: new Prisma.Decimal(50) }),
      stockRow({ name: 'Vazio', currentQuantity: new Prisma.Decimal(0) }),
    ]);

    const context = await builder.build(CLINIC);

    expect(context.criticalProducts.map((p) => p.name)).toEqual(['Vazio']);
  });

  it('orders them by how urgent they are', async () => {
    prisma.stockProduct.findMany.mockResolvedValue([
      stockRow({
        name: 'Baixo',
        currentQuantity: new Prisma.Decimal(2),
        minQuantity: new Prisma.Decimal(2),
      }),
      stockRow({
        name: 'Vencendo',
        expiresAt: new Date('2026-06-20T00:00:00.000Z'),
      }),
      stockRow({ name: 'Vazio', currentQuantity: new Prisma.Decimal(0) }),
      stockRow({
        name: 'Vencido',
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ]);

    const context = await builder.build(CLINIC);

    expect(context.criticalProducts.map((p) => p.name)).toEqual([
      'Vazio',
      'Vencido',
      'Vencendo',
      'Baixo',
    ]);
  });

  it('sends at most ten of them', async () => {
    prisma.stockProduct.findMany.mockResolvedValue(
      Array.from({ length: 14 }, (_, i) =>
        stockRow({
          name: `Produto ${i}`,
          currentQuantity: new Prisma.Decimal(0),
        }),
      ),
    );

    const context = await builder.build(CLINIC);

    expect(context.criticalProducts).toHaveLength(10);
  });

  it('does not call a product expiring today expired', async () => {
    prisma.stockProduct.findMany.mockResolvedValue([
      stockRow({ expiresAt: new Date('2026-06-15T00:00:00.000Z') }),
    ]);

    const context = await builder.build(CLINIC);

    // Same Brazil-vs-UTC boundary the stock service handles; the two must not
    // disagree, or the assistant contradicts the screen beside it.
    expect(context.criticalProducts[0].status).toBe('EXPIRING');
  });

  it('breaks the stock down by category, most critical first', async () => {
    prisma.stockProduct.findMany.mockResolvedValue([
      stockRow({ category: { name: 'Anestésicos' } }),
      stockRow({
        category: { name: 'Descartáveis' },
        currentQuantity: new Prisma.Decimal(0),
      }),
      stockRow({
        category: { name: 'Descartáveis' },
        currentQuantity: new Prisma.Decimal(0),
      }),
    ]);

    const context = await builder.build(CLINIC);

    expect(context.categoryBreakdown).toEqual([
      { categoryName: 'Descartáveis', totalProducts: 2, criticalCount: 2 },
      { categoryName: 'Anestésicos', totalProducts: 1, criticalCount: 0 },
    ]);
  });

  it('groups uncategorised products under a readable label', async () => {
    prisma.stockProduct.findMany.mockResolvedValue([
      stockRow({ category: null }),
    ]);

    const context = await builder.build(CLINIC);

    expect(context.categoryBreakdown[0].categoryName).toBe('Sem categoria');
  });

  it('exposes the quantities as numbers, not decimals', async () => {
    prisma.stockProduct.findMany.mockResolvedValue([
      stockRow({
        currentQuantity: new Prisma.Decimal('1.50'),
        minQuantity: new Prisma.Decimal('2.25'),
      }),
    ]);

    const context = await builder.build(CLINIC);

    expect(context.criticalProducts[0]).toMatchObject({
      currentQuantity: 1.5,
      minQuantity: 2.25,
    });
  });

  describe('what it admits not knowing', () => {
    it('says so when the clinic has no active products', async () => {
      stock.getSummary.mockResolvedValue({ ...summary, totalActive: 0 });

      const context = await builder.build(CLINIC);

      expect(context.limitations).toContain('Nenhum produto ativo cadastrado.');
    });

    it('says so when nothing has a purchase price', async () => {
      stock.getSummary.mockResolvedValue({ ...summary, estimatedValue: 0 });

      const context = await builder.build(CLINIC);

      // A zero valuation is a missing price, not a worthless stockroom, and
      // the model must be told which.
      expect(context.limitations).toContain(
        'Valor estimado indisponível — preço de compra não cadastrado em todos os produtos.',
      );
    });

    it('lists nothing when the stock is fully described', async () => {
      const context = await builder.build(CLINIC);

      expect(context.limitations).toEqual([]);
    });
  });
});
