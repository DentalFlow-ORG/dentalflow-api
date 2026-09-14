import {
  ForbiddenException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  FinancialTransactionStatus,
  FinancialTransactionType,
} from '@prisma/client';

import { MonthlyFinanceDiagnosisService } from './monthly-finance-diagnosis.service';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockPrisma = {
  financialTransaction: {
    findMany: jest.fn(),
  },
  aiAssistantAnalysis: {
    findFirst: jest.fn(),
    create: jest.fn(),
  },
};

const mockRepository = {
  saveSuccess: jest.fn(),
  saveError: jest.fn(),
  findLatest: jest.fn(),
};

const mockQuotaService = {
  getQuota: jest.fn(),
  assertQuota: jest.fn(),
};

// ── Helpers ────────────────────────────────────────────────────────────────────

const CLINIC_ID = 'clinic-1';
const OTHER_CLINIC_ID = 'clinic-2';
const USER_ID = 'user-1';
const MONTH = '2026-05';

function makeTransaction(
  overrides: Partial<{
    id: string;
    clinicId: string;
    type: FinancialTransactionType;
    amount: string;
    transactionDate: Date;
    status: FinancialTransactionStatus;
    category: {
      id: string;
      name: string;
      type: FinancialTransactionType;
      isDefault: boolean;
    };
  }> = {},
) {
  return {
    id: 'tx-1',
    clinicId: CLINIC_ID,
    type: FinancialTransactionType.INCOME,
    amount: '1000.00',
    transactionDate: new Date('2026-05-10T00:00:00Z'),
    status: FinancialTransactionStatus.PAID,
    category: {
      id: 'cat-1',
      name: 'Servicos odontologicos',
      type: FinancialTransactionType.INCOME,
      isDefault: true,
    },
    ...overrides,
  };
}

const PROFESSIONAL_QUOTA = {
  allowed: true,
  planKey: 'professional',
  used: 0,
  remaining: 5,
  limit: 5,
  nextResetAt: '2026-06-01T00:00:00Z',
  lastGeneratedAt: null,
  blockedReason: null,
};

const PREMIUM_QUOTA = {
  ...PROFESSIONAL_QUOTA,
  planKey: 'premium',
  remaining: 20,
  limit: 20,
};

const STARTER_QUOTA = {
  allowed: false,
  planKey: 'starter',
  used: 0,
  remaining: 0,
  limit: 0,
  nextResetAt: '2026-06-01T00:00:00Z',
  lastGeneratedAt: null,
  blockedReason: 'Não disponível neste plano.',
};

const EXHAUSTED_QUOTA = { ...PROFESSIONAL_QUOTA, remaining: 0, used: 5 };

const AI_RESPONSE = {
  summary: 'Mês com resultado positivo.',
  financialHealth: 'HEALTHY',
  highlights: ['Receita acima do esperado.'],
  risks: ['Despesas operacionais crescentes.'],
  recommendedActions: ['Revisar categorias de despesas.'],
};

function buildService() {
  const svc = new MonthlyFinanceDiagnosisService(
    mockPrisma as any,
    mockRepository as any,
    mockQuotaService as any,
  );
  return svc;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('MonthlyFinanceDiagnosisService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
    mockRepository.saveSuccess.mockResolvedValue({});
    mockRepository.saveError.mockResolvedValue({});
    mockPrisma.aiAssistantAnalysis.findFirst.mockResolvedValue(null);
    mockPrisma.aiAssistantAnalysis.create.mockResolvedValue({});
    mockQuotaService.getQuota.mockResolvedValue(PROFESSIONAL_QUOTA);
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  // ── 1. Deterministic summary: revenue, expenses, profit ───────────────────

  it('1. calculates revenue, expenses and profit correctly', async () => {
    const svc = buildService();
    const { firstDay, nextMonth } = svc.monthBounds(MONTH);

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeTransaction({
        type: FinancialTransactionType.INCOME,
        amount: '3000.00',
        transactionDate: new Date('2026-05-05T00:00:00Z'),
      }),
      makeTransaction({
        id: 'tx-2',
        type: FinancialTransactionType.EXPENSE,
        amount: '1200.00',
        transactionDate: new Date('2026-05-10T00:00:00Z'),
        category: {
          id: 'cat-e',
          name: 'Aluguel',
          type: FinancialTransactionType.EXPENSE,
          isDefault: true,
        },
      }),
    ]);

    const snapshot = await svc.buildFinanceSnapshot(
      CLINIC_ID,
      MONTH,
      firstDay,
      nextMonth,
    );

    expect(snapshot.revenueCents).toBe(300000);
    expect(snapshot.expenseCents).toBe(120000);
    expect(snapshot.profitCents).toBe(180000);
  });

  // ── 2. Profit margin ──────────────────────────────────────────────────────

  it('2. calculates profit margin correctly and returns null when revenue is zero', async () => {
    const svc = buildService();
    const { firstDay, nextMonth } = svc.monthBounds(MONTH);

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeTransaction({
        type: FinancialTransactionType.INCOME,
        amount: '2000.00',
        transactionDate: new Date('2026-05-03T00:00:00Z'),
      }),
      makeTransaction({
        id: 'tx-2',
        type: FinancialTransactionType.EXPENSE,
        amount: '500.00',
        transactionDate: new Date('2026-05-03T00:00:00Z'),
        category: {
          id: 'cat-e',
          name: 'Materiais',
          type: FinancialTransactionType.EXPENSE,
          isDefault: true,
        },
      }),
    ]);
    const snapshotWithRevenue = await svc.buildFinanceSnapshot(
      CLINIC_ID,
      MONTH,
      firstDay,
      nextMonth,
    );
    expect(snapshotWithRevenue.profitMarginPercent).toBeCloseTo(75, 1);

    mockPrisma.financialTransaction.findMany.mockResolvedValue([]);
    const snapshotNoRevenue = await svc.buildFinanceSnapshot(
      CLINIC_ID,
      MONTH,
      firstDay,
      nextMonth,
    );
    expect(snapshotNoRevenue.profitMarginPercent).toBeNull();
  });

  // ── 3. Top expense categories ──────────────────────────────────────────────

  it('3. builds top 5 expense categories sorted by amount descending', async () => {
    const svc = buildService();
    const { firstDay, nextMonth } = svc.monthBounds(MONTH);

    const makeExpense = (id: string, catName: string, amount: string) =>
      makeTransaction({
        id,
        type: FinancialTransactionType.EXPENSE,
        amount,
        transactionDate: new Date('2026-05-10T00:00:00Z'),
        category: {
          id: `cat-${id}`,
          name: catName,
          type: FinancialTransactionType.EXPENSE,
          isDefault: false,
        },
      });

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeExpense('e1', 'Salarios', '4000.00'),
      makeExpense('e2', 'Aluguel', '2000.00'),
      makeExpense('e3', 'Materiais', '1500.00'),
      makeExpense('e4', 'Impostos', '800.00'),
      makeExpense('e5', 'Software e ferramentas', '300.00'),
      makeExpense('e6', 'Marketing', '100.00'),
    ]);

    const snapshot = await svc.buildFinanceSnapshot(
      CLINIC_ID,
      MONTH,
      firstDay,
      nextMonth,
    );

    expect(snapshot.topExpenseCategories).toHaveLength(5);
    expect(snapshot.topExpenseCategories[0].categoryName).toBe('Salarios');
    expect(snapshot.topExpenseCategories[0].amountCents).toBe(400000);
    expect(snapshot.topExpenseCategories[4].categoryName).toBe(
      'Software e ferramentas',
    );
  });

  // ── 4. Uncategorized expense count ────────────────────────────────────────

  it('4. counts expenses in default catch-all category as uncategorized', async () => {
    const svc = buildService();
    const { firstDay, nextMonth } = svc.monthBounds(MONTH);

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeTransaction({
        id: 'e1',
        type: FinancialTransactionType.EXPENSE,
        amount: '500.00',
        transactionDate: new Date('2026-05-10T00:00:00Z'),
        category: {
          id: 'cat-manual',
          name: 'Despesas manuais',
          type: FinancialTransactionType.EXPENSE,
          isDefault: true,
        },
      }),
      makeTransaction({
        id: 'e2',
        type: FinancialTransactionType.EXPENSE,
        amount: '800.00',
        transactionDate: new Date('2026-05-10T00:00:00Z'),
        category: {
          id: 'cat-manual',
          name: 'Despesas manuais',
          type: FinancialTransactionType.EXPENSE,
          isDefault: true,
        },
      }),
      makeTransaction({
        id: 'e3',
        type: FinancialTransactionType.EXPENSE,
        amount: '200.00',
        transactionDate: new Date('2026-05-10T00:00:00Z'),
        category: {
          id: 'cat-aluguel',
          name: 'Aluguel',
          type: FinancialTransactionType.EXPENSE,
          isDefault: true,
        },
      }),
    ]);

    const snapshot = await svc.buildFinanceSnapshot(
      CLINIC_ID,
      MONTH,
      firstDay,
      nextMonth,
    );
    expect(snapshot.uncategorizedExpenseCount).toBe(2);
  });

  // ── 5. Weekly cashflow grouping ───────────────────────────────────────────

  it('5. groups transactions into 4 weekly buckets', async () => {
    const svc = buildService();
    const { firstDay, nextMonth } = svc.monthBounds(MONTH);

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeTransaction({
        id: 't1',
        type: FinancialTransactionType.INCOME,
        amount: '1000.00',
        transactionDate: new Date('2026-05-03T00:00:00Z'),
      }),
      makeTransaction({
        id: 't2',
        type: FinancialTransactionType.INCOME,
        amount: '2000.00',
        transactionDate: new Date('2026-05-12T00:00:00Z'),
      }),
      makeTransaction({
        id: 't3',
        type: FinancialTransactionType.EXPENSE,
        amount: '500.00',
        transactionDate: new Date('2026-05-20T00:00:00Z'),
        category: {
          id: 'cat-e',
          name: 'Materiais',
          type: FinancialTransactionType.EXPENSE,
          isDefault: false,
        },
      }),
      makeTransaction({
        id: 't4',
        type: FinancialTransactionType.INCOME,
        amount: '3000.00',
        transactionDate: new Date('2026-05-25T00:00:00Z'),
      }),
    ]);

    const snapshot = await svc.buildFinanceSnapshot(
      CLINIC_ID,
      MONTH,
      firstDay,
      nextMonth,
    );

    expect(snapshot.cashflowByWeek).toHaveLength(4);
    expect(snapshot.cashflowByWeek[0].incomeCents).toBe(100000); // week 1: day 3
    expect(snapshot.cashflowByWeek[1].incomeCents).toBe(200000); // week 2: day 12
    expect(snapshot.cashflowByWeek[2].expenseCents).toBe(50000); // week 3: day 20
    expect(snapshot.cashflowByWeek[3].incomeCents).toBe(300000); // week 4: day 25
    expect(snapshot.cashflowByWeek[2].netCents).toBe(-50000);
  });

  // ── 6. LOW_DATA alert ─────────────────────────────────────────────────────

  it('6. returns LOW_DATA alert and skips AI when no transactions', async () => {
    const svc = buildService();
    svc.openai = { chat: { completions: { create: jest.fn() } } } as any;

    mockPrisma.financialTransaction.findMany.mockResolvedValue([]);

    const result = await svc.diagnose(USER_ID, CLINIC_ID, { month: MONTH });

    expect(
      result.financeSnapshot.alerts.some((a) => a.type === 'LOW_DATA'),
    ).toBe(true);
    expect((svc.openai as any).chat.completions.create).not.toHaveBeenCalled();
    expect(mockQuotaService.getQuota).not.toHaveBeenCalled();
    expect(mockRepository.saveSuccess).not.toHaveBeenCalled();
  });

  // ── 7. Starter blocked ────────────────────────────────────────────────────

  it('7. throws ForbiddenException for Starter plan', async () => {
    const svc = buildService();
    svc.openai = { chat: { completions: { create: jest.fn() } } } as any;

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeTransaction({ transactionDate: new Date('2026-05-10T00:00:00Z') }),
    ]);
    mockPrisma.aiAssistantAnalysis.findFirst.mockResolvedValue(null);
    mockQuotaService.getQuota.mockResolvedValue(STARTER_QUOTA);

    await expect(
      svc.diagnose(USER_ID, CLINIC_ID, { month: MONTH }),
    ).rejects.toThrow(ForbiddenException);
    expect((svc.openai as any).chat.completions.create).not.toHaveBeenCalled();
  });

  // ── 8. Professional allowed ───────────────────────────────────────────────

  it('8. allows Professional plan and calls AI', async () => {
    const svc = buildService();
    const mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(AI_RESPONSE) } }],
    });
    svc.openai = { chat: { completions: { create: mockCreate } } } as any;

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeTransaction({ transactionDate: new Date('2026-05-10T00:00:00Z') }),
    ]);
    mockPrisma.aiAssistantAnalysis.findFirst.mockResolvedValue(null);
    mockQuotaService.getQuota.mockResolvedValue(PROFESSIONAL_QUOTA);

    const result = await svc.diagnose(USER_ID, CLINIC_ID, { month: MONTH });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('AI');
    expect(result.summary).toBe(AI_RESPONSE.summary);
  });

  // ── 9. Premium allowed ────────────────────────────────────────────────────

  it('9. allows Premium plan and calls AI', async () => {
    const svc = buildService();
    const mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(AI_RESPONSE) } }],
    });
    svc.openai = { chat: { completions: { create: mockCreate } } } as any;

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeTransaction({ transactionDate: new Date('2026-05-10T00:00:00Z') }),
    ]);
    mockPrisma.aiAssistantAnalysis.findFirst.mockResolvedValue(null);
    mockQuotaService.getQuota.mockResolvedValue(PREMIUM_QUOTA);

    const result = await svc.diagnose(USER_ID, CLINIC_ID, { month: MONTH });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('AI');
  });

  // ── 10. Quota exceeded ────────────────────────────────────────────────────

  it('10. throws 429 when quota is exhausted', async () => {
    const svc = buildService();
    svc.openai = { chat: { completions: { create: jest.fn() } } } as any;

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeTransaction({ transactionDate: new Date('2026-05-10T00:00:00Z') }),
    ]);
    mockPrisma.aiAssistantAnalysis.findFirst.mockResolvedValue(null);
    mockQuotaService.getQuota.mockResolvedValue(EXHAUSTED_QUOTA);

    await expect(
      svc.diagnose(USER_ID, CLINIC_ID, { month: MONTH }),
    ).rejects.toMatchObject({
      status: 429,
    });
    expect((svc.openai as any).chat.completions.create).not.toHaveBeenCalled();
  });

  // ── 11. Cache hit does not call AI or consume quota ───────────────────────

  it('11. returns cached result without calling AI or checking quota', async () => {
    const svc = buildService();
    svc.openai = { chat: { completions: { create: jest.fn() } } } as any;

    const cachedContent = {
      month: MONTH,
      summary: 'Resultado do cache.',
      financialHealth: 'HEALTHY',
      highlights: ['Ponto positivo.'],
      risks: [],
      recommendedActions: ['Ação recomendada.'],
      financeSnapshot: {
        month: MONTH,
        revenueCents: 100000,
        expenseCents: 50000,
        profitCents: 50000,
        profitMarginPercent: 50,
        transactionCount: 5,
        incomeTransactionCount: 3,
        expenseTransactionCount: 2,
        uncategorizedExpenseCount: 0,
        topExpenseCategories: [],
        cashflowByWeek: [],
        alerts: [],
      },
    };

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeTransaction({ transactionDate: new Date('2026-05-10T00:00:00Z') }),
    ]);
    mockPrisma.aiAssistantAnalysis.findFirst.mockResolvedValue({
      content: cachedContent,
      generatedAt: new Date('2026-05-20T10:00:00Z'),
    });

    const result = await svc.diagnose(USER_ID, CLINIC_ID, { month: MONTH });

    expect(result.cached).toBe(true);
    expect(result.source).toBe('CACHE');
    expect(result.summary).toBe('Resultado do cache.');
    expect(mockQuotaService.getQuota).not.toHaveBeenCalled();
    expect((svc.openai as any).chat.completions.create).not.toHaveBeenCalled();
  });

  // ── 12. forceRefresh bypasses cache and calls AI ──────────────────────────

  it('12. forceRefresh bypasses cache and calls AI', async () => {
    const svc = buildService();
    const mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(AI_RESPONSE) } }],
    });
    svc.openai = { chat: { completions: { create: mockCreate } } } as any;

    const cachedContent = {
      month: MONTH,
      summary: 'Old cached result.',
      financialHealth: 'WARNING',
      highlights: [],
      risks: [],
      recommendedActions: [],
      financeSnapshot: {},
    };

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeTransaction({ transactionDate: new Date('2026-05-10T00:00:00Z') }),
    ]);
    mockPrisma.aiAssistantAnalysis.findFirst.mockResolvedValue({
      content: cachedContent,
      generatedAt: new Date('2026-05-20T10:00:00Z'),
    });
    mockQuotaService.getQuota.mockResolvedValue(PROFESSIONAL_QUOTA);

    const result = await svc.diagnose(USER_ID, CLINIC_ID, {
      month: MONTH,
      forceRefresh: true,
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.cached).toBe(false);
    expect(result.source).toBe('AI');
    expect(result.summary).toBe(AI_RESPONSE.summary);
  });

  // ── 13. Empty/insufficient data skips AI ─────────────────────────────────

  it('13. zero transactions returns deterministic LOW_DATA without calling AI', async () => {
    const svc = buildService();
    svc.openai = { chat: { completions: { create: jest.fn() } } } as any;

    mockPrisma.financialTransaction.findMany.mockResolvedValue([]);
    mockPrisma.aiAssistantAnalysis.findFirst.mockResolvedValue(null);

    const result = await svc.diagnose(USER_ID, CLINIC_ID, { month: MONTH });

    expect((svc.openai as any).chat.completions.create).not.toHaveBeenCalled();
    expect(result.financeSnapshot.transactionCount).toBe(0);
    expect(result.recommendedActions).toContain(
      'Registre as receitas recebidas no mês.',
    );
  });

  // ── 14. AI context excludes sensitive data ────────────────────────────────

  it('14. AI context does not contain transaction IDs, patient data or raw rows', async () => {
    const svc = buildService();
    let capturedContext: string | undefined;

    const mockCreate = jest
      .fn()
      .mockImplementation(
        (params: { messages: { role: string; content: string }[] }) => {
          capturedContext = params.messages.find(
            (m) => m.role === 'user',
          )?.content;
          return Promise.resolve({
            choices: [{ message: { content: JSON.stringify(AI_RESPONSE) } }],
          });
        },
      );
    svc.openai = { chat: { completions: { create: mockCreate } } } as any;

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeTransaction({
        id: 'tx-sensitive-id',
        transactionDate: new Date('2026-05-10T00:00:00Z'),
      }),
    ]);
    mockPrisma.aiAssistantAnalysis.findFirst.mockResolvedValue(null);
    mockQuotaService.getQuota.mockResolvedValue(PROFESSIONAL_QUOTA);

    await svc.diagnose(USER_ID, CLINIC_ID, { month: MONTH });

    expect(capturedContext).toBeDefined();
    expect(capturedContext).not.toContain('tx-sensitive-id');
    expect(capturedContext).not.toContain(CLINIC_ID);
    expect(capturedContext).not.toContain(USER_ID);
    expect(capturedContext).not.toContain('appointmentId');
    expect(capturedContext).not.toContain('profileId');
    expect(capturedContext).not.toContain('createdByUserId');
    expect(capturedContext).not.toContain('paymentReference');
  });

  // ── 15. AI provider error returns friendly error ──────────────────────────

  it('15. AI provider generic error throws InternalServerErrorException', async () => {
    const svc = buildService();
    svc.openai = {
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(new Error('OpenAI failure')),
        },
      },
    } as any;

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeTransaction({ transactionDate: new Date('2026-05-10T00:00:00Z') }),
    ]);
    mockPrisma.aiAssistantAnalysis.findFirst.mockResolvedValue(null);
    mockQuotaService.getQuota.mockResolvedValue(PROFESSIONAL_QUOTA);

    await expect(
      svc.diagnose(USER_ID, CLINIC_ID, { month: MONTH }),
    ).rejects.toThrow(InternalServerErrorException);
    expect(mockRepository.saveError).toHaveBeenCalled();
  });

  it('15b. AI rate-limit error throws ServiceUnavailableException', async () => {
    const svc = buildService();
    const rateLimitError = Object.assign(new Error('Rate limit'), {
      status: 429,
    });
    svc.openai = {
      chat: {
        completions: { create: jest.fn().mockRejectedValue(rateLimitError) },
      },
    } as any;

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeTransaction({ transactionDate: new Date('2026-05-10T00:00:00Z') }),
    ]);
    mockPrisma.aiAssistantAnalysis.findFirst.mockResolvedValue(null);
    mockQuotaService.getQuota.mockResolvedValue(PROFESSIONAL_QUOTA);

    await expect(
      svc.diagnose(USER_ID, CLINIC_ID, { month: MONTH }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  // ── 16. Cross-clinic isolation ────────────────────────────────────────────

  it('16. queries use clinicId and do not bleed between clinics', async () => {
    const svc = buildService();
    const mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(AI_RESPONSE) } }],
    });
    svc.openai = { chat: { completions: { create: mockCreate } } } as any;

    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      makeTransaction({
        clinicId: OTHER_CLINIC_ID,
        transactionDate: new Date('2026-05-10T00:00:00Z'),
      }),
    ]);
    mockPrisma.aiAssistantAnalysis.findFirst.mockResolvedValue(null);
    mockQuotaService.getQuota.mockResolvedValue(PROFESSIONAL_QUOTA);

    await svc.diagnose(USER_ID, CLINIC_ID, { month: MONTH });

    const findCall = mockPrisma.financialTransaction.findMany.mock.calls[0][0];
    expect(findCall.where.clinicId).toBe(CLINIC_ID);

    const cacheCall = mockPrisma.aiAssistantAnalysis.findFirst.mock.calls[0][0];
    expect(cacheCall.where.clinicId).toBe(CLINIC_ID);
  });

  // ── 17. Invalid month rejected ────────────────────────────────────────────

  it('17. monthBounds correctly parses YYYY-MM into UTC date range', () => {
    const svc = buildService();

    const { firstDay, nextMonth } = svc.monthBounds('2026-05');
    expect(firstDay.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(nextMonth.toISOString()).toBe('2026-06-01T00:00:00.000Z');

    const { firstDay: jan, nextMonth: feb } = svc.monthBounds('2026-01');
    expect(jan.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(feb.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });
});
