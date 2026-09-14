import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FinancialTransactionType } from '@prisma/client';

import { ExpenseClassifierService } from './expense-classifier.service';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockPrisma = {
  financialTransaction: {
    findFirst: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  financialCategory: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
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
};

// ── Helpers ────────────────────────────────────────────────────────────────────

const CLINIC_ID = 'clinic-1';
const OTHER_CLINIC_ID = 'clinic-2';
const USER_ID = 'user-1';
const TX_ID = 'tx-1';

const NOW = new Date('2026-05-26T10:00:00Z');

const EXPENSE_CATEGORIES = [
  { id: 'cat-aluguel', name: 'Aluguel', type: FinancialTransactionType.EXPENSE },
  { id: 'cat-salarios', name: 'Salarios', type: FinancialTransactionType.EXPENSE },
  { id: 'cat-materiais', name: 'Materiais', type: FinancialTransactionType.EXPENSE },
  { id: 'cat-impostos', name: 'Impostos', type: FinancialTransactionType.EXPENSE },
  { id: 'cat-software', name: 'Software e ferramentas', type: FinancialTransactionType.EXPENSE },
  { id: 'cat-outros', name: 'Despesas manuais', type: FinancialTransactionType.EXPENSE },
];

function buildTransaction(overrides: Partial<{
  id: string;
  clinicId: string;
  type: FinancialTransactionType;
  description: string;
  amount: string;
  transactionDate: Date;
  updatedAt: Date;
  appointmentId: string | null;
  profileId: string | null;
}> = {}) {
  return {
    id: TX_ID,
    clinicId: CLINIC_ID,
    type: FinancialTransactionType.EXPENSE,
    description: 'Pagamento aluguel escritorio',
    amount: '1500.00',
    transactionDate: NOW,
    updatedAt: NOW,
    appointmentId: null,
    profileId: null,
    ...overrides,
  };
}

function mockQuota(planKey: string, allowed: boolean, remaining: number, limit: number) {
  mockQuotaService.getQuota.mockResolvedValue({
    allowed,
    planKey,
    used: limit - remaining,
    remaining,
    limit,
    nextResetAt: new Date(Date.UTC(2026, 6, 1)).toISOString(),
    lastGeneratedAt: null,
    blockedReason: allowed ? null : 'Plano não permite.',
  });
}

function mockOpenAi(service: ExpenseClassifierService, responseJson: string) {
  (service as unknown as { openai: { chat: { completions: { create: jest.Mock } } } }).openai = {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: responseJson } }],
        }),
      },
    },
  };
}

function getOpenAiMock(service: ExpenseClassifierService): jest.Mock {
  return (service as unknown as { openai: { chat: { completions: { create: jest.Mock } } } })
    .openai.chat.completions.create;
}

function buildService() {
  return new ExpenseClassifierService(
    mockPrisma as never,
    mockRepository as never,
    mockQuotaService as never,
  );
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('ExpenseClassifierService', () => {
  let service: ExpenseClassifierService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(buildTransaction());
    mockPrisma.financialCategory.findMany.mockResolvedValue(EXPENSE_CATEGORIES);
    mockPrisma.financialCategory.findFirst.mockResolvedValue(EXPENSE_CATEGORIES[0]);
    mockPrisma.aiAssistantAnalysis.findFirst.mockResolvedValue(null);
    mockPrisma.aiAssistantAnalysis.create.mockResolvedValue({});
    mockRepository.saveSuccess.mockResolvedValue(undefined);
    mockRepository.saveError.mockResolvedValue(undefined);
    service = buildService();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  // ── 1. Keyword match — no AI ───────────────────────────────────────────────

  it('returns RULE result without calling AI when description matches keyword', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(
      buildTransaction({ description: 'Pagamento aluguel do mes' }),
    );
    mockQuota('professional', true, 30, 30);
    mockOpenAi(service, '{}');
    const mockCreate = getOpenAiMock(service);

    const result = await service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, {});

    expect(result.source).toBe('RULE');
    expect(result.suggestedCategoryName).toBe('Aluguel');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.quotaUsed).toBe(false);
  });

  // ── 2. Category-name match — no AI ────────────────────────────────────────

  it('returns RULE result without calling AI when description contains category name', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(
      buildTransaction({ description: 'Materiais odontologicos do mes' }),
    );
    mockQuota('professional', true, 30, 30);
    mockOpenAi(service, '{}');
    const mockCreate = getOpenAiMock(service);

    const result = await service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, {});

    expect(result.source).toBe('RULE');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ── 3. Low confidence — AI called ─────────────────────────────────────────

  it('calls AI when deterministic confidence is below threshold', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(
      buildTransaction({ description: 'Pagamento ref 12345 xpto' }),
    );
    mockQuota('professional', true, 30, 30);
    mockOpenAi(
      service,
      JSON.stringify({ categoryName: 'Materiais', confidence: 0.8, reason: 'IA sugeriu.' }),
    );

    const result = await service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, {});

    expect(result.source).toBe('AI');
    expect(result.quotaUsed).toBe(true);
    expect(getOpenAiMock(service)).toHaveBeenCalledTimes(1);
  });

  // ── 4. forceAi — AI called even if rule matched ────────────────────────────

  it('calls AI even when rule confidence is high if forceAi is true', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(
      buildTransaction({ description: 'Pagamento aluguel do mes' }),
    );
    mockQuota('professional', true, 30, 30);
    mockOpenAi(
      service,
      JSON.stringify({ categoryName: 'Aluguel', confidence: 0.95, reason: 'Confirmado pela IA.' }),
    );

    const result = await service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, { forceAi: true });

    expect(result.source).toBe('AI');
    expect(getOpenAiMock(service)).toHaveBeenCalledTimes(1);
  });

  // ── 5. Starter blocked ─────────────────────────────────────────────────────

  it('throws ForbiddenException for starter plan', async () => {
    mockQuota('starter', false, 0, 0);

    await expect(
      service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, {}),
    ).rejects.toThrow(ForbiddenException);
  });

  // ── 6. Professional allowed ────────────────────────────────────────────────

  it('returns AI result for professional plan with quota available', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(
      buildTransaction({ description: 'Descricao sem palavras chave claras' }),
    );
    mockQuota('professional', true, 30, 30);
    mockOpenAi(
      service,
      JSON.stringify({ categoryName: 'Materiais', confidence: 0.82, reason: 'IA classificou.' }),
    );

    const result = await service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, {});

    expect(result.source).toBe('AI');
    expect(result.suggestedCategoryName).toBe('Materiais');
  });

  // ── 7. Premium allowed ─────────────────────────────────────────────────────

  it('returns AI result for premium plan with quota available', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(
      buildTransaction({ description: 'Despesa diversa sem categoria obvia' }),
    );
    mockQuota('premium', true, 100, 100);
    mockOpenAi(
      service,
      JSON.stringify({ categoryName: 'Impostos', confidence: 0.78, reason: 'IA classificou.' }),
    );

    const result = await service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, {});

    expect(result.source).toBe('AI');
    expect(result.suggestedCategoryName).toBe('Impostos');
  });

  // ── 8. Quota exhausted ─────────────────────────────────────────────────────

  it('throws 429 when quota is exhausted', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(
      buildTransaction({ description: 'Descricao sem palavras chave' }),
    );
    mockQuota('professional', true, 0, 30);

    await expect(
      service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, {}),
    ).rejects.toMatchObject({ status: 429 });
  });

  // ── 9. Cache hit — no AI, no quota ────────────────────────────────────────

  it('returns cached result without calling AI when cache hit exists', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(
      buildTransaction({ description: 'Descricao sem palavras chave', updatedAt: NOW }),
    );
    mockQuota('professional', true, 30, 30);
    mockPrisma.aiAssistantAnalysis.findFirst.mockResolvedValue({
      content: {
        transactionId: TX_ID,
        suggestedCategoryName: 'Impostos',
        confidence: 0.82,
        reason: 'Cache IA.',
        transactionUpdatedAt: NOW.toISOString(),
      },
      generatedAt: NOW,
    });
    mockOpenAi(service, '{}');
    const mockCreate = getOpenAiMock(service);

    const result = await service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, {});

    expect(result.source).toBe('CACHE');
    expect(result.quotaUsed).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ── 10. AI must choose only existing category ──────────────────────────────

  it('treats AI-suggested category as null if not in available categories', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(
      buildTransaction({ description: 'Despesa estranha sem categorias' }),
    );
    mockQuota('professional', true, 30, 30);
    mockOpenAi(
      service,
      JSON.stringify({ categoryName: 'CategoriaInventada', confidence: 0.9, reason: 'IA inventou.' }),
    );

    const result = await service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, {});

    expect(result.suggestedCategoryId).toBeNull();
    expect(result.suggestedCategoryName).toBeNull();
    expect(result.source).toBe('NO_MATCH');
  });

  // ── 11. AI returns null ────────────────────────────────────────────────────

  it('returns NO_MATCH when AI returns null categoryName', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(
      buildTransaction({ description: 'Transacao inexplicavel' }),
    );
    mockQuota('professional', true, 30, 30);
    mockOpenAi(
      service,
      JSON.stringify({ categoryName: null, confidence: 0.3, reason: 'Sem categoria adequada.' }),
    );

    const result = await service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, {});

    expect(result.source).toBe('NO_MATCH');
    expect(result.suggestedCategoryId).toBeNull();
    expect(result.requiresConfirmation).toBe(true);
  });

  // ── 12. Apply validates same-clinic category ───────────────────────────────

  it('throws NotFoundException when categoryId belongs to different clinic', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(buildTransaction());
    mockPrisma.financialCategory.findFirst.mockResolvedValue(null);

    await expect(
      service.applySuggestedCategory(CLINIC_ID, TX_ID, { categoryId: 'cat-other-clinic' }),
    ).rejects.toThrow(NotFoundException);
  });

  // ── 13. Cross-clinic isolation — transaction ───────────────────────────────

  it('throws NotFoundException when transactionId belongs to another clinic', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(null);
    mockQuota('professional', true, 30, 30);

    await expect(
      service.classifyExpense(USER_ID, OTHER_CLINIC_ID, TX_ID, {}),
    ).rejects.toThrow(NotFoundException);
  });

  // ── 14. INCOME transaction rejected ───────────────────────────────────────

  it('throws BadRequestException for INCOME transaction', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(
      buildTransaction({ type: FinancialTransactionType.INCOME }),
    );
    mockQuota('professional', true, 30, 30);

    await expect(
      service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, {}),
    ).rejects.toThrow(BadRequestException);
  });

  // ── 15. Batch max 20 enforced ─────────────────────────────────────────────

  it('throws BadRequestException when batch has more than 20 transactionIds', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `tx-${i}`);

    await expect(
      service.classifyBatch(USER_ID, CLINIC_ID, { transactionIds: ids }),
    ).rejects.toThrow(BadRequestException);
  });

  // ── 16. Batch: deterministic results do not consume quota ─────────────────

  it('does not consume quota when all batch items are classified deterministically', async () => {
    const ids = ['tx-1', 'tx-2'];
    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      buildTransaction({ id: 'tx-1', description: 'Aluguel do escritorio' }),
      buildTransaction({ id: 'tx-2', description: 'Pagamento salario funcionario' }),
    ]);
    mockQuota('professional', true, 30, 30);
    mockOpenAi(service, '{}');

    const result = await service.classifyBatch(USER_ID, CLINIC_ID, { transactionIds: ids });

    expect(result.summary.quotaUsed).toBe(0);
    expect(getOpenAiMock(service)).not.toHaveBeenCalled();
  });

  // ── 17. Batch: AI only for uncertain items ────────────────────────────────

  it('calls AI only for items with low deterministic confidence in batch', async () => {
    const ids = ['tx-certain', 'tx-uncertain'];
    mockPrisma.financialTransaction.findMany.mockResolvedValue([
      buildTransaction({ id: 'tx-certain', description: 'Aluguel escritorio' }),
      buildTransaction({ id: 'tx-uncertain', description: 'Pagamento ref 99999 misc' }),
    ]);
    mockQuota('professional', true, 30, 30);
    mockOpenAi(
      service,
      JSON.stringify({ categoryName: 'Impostos', confidence: 0.78, reason: 'IA.' }),
    );

    const result = await service.classifyBatch(USER_ID, CLINIC_ID, { transactionIds: ids });

    expect(result.summary.quotaUsed).toBe(1);
    expect(getOpenAiMock(service)).toHaveBeenCalledTimes(1);

    const certainItem = result.items.find((i) => i.transactionId === 'tx-certain')!;
    const uncertainItem = result.items.find((i) => i.transactionId === 'tx-uncertain')!;
    expect(certainItem.source).toBe('RULE');
    expect(uncertainItem.source).toBe('AI');
  });

  // ── 18. AI context does not contain patient/clinical data ─────────────────

  it('does not include patientId, appointmentId or profileId in AI context', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(
      buildTransaction({
        description: 'Despesa sem categoria obvia',
        appointmentId: 'appt-999',
        profileId: 'profile-999',
      }),
    );
    mockQuota('professional', true, 30, 30);
    mockOpenAi(
      service,
      JSON.stringify({ categoryName: null, confidence: 0.3, reason: 'Sem match.' }),
    );

    await service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, {});

    const mockCreate = getOpenAiMock(service);
    const calledWith = mockCreate.mock.calls[0][0];
    const userMessage = calledWith.messages[1].content;
    const context = JSON.parse(userMessage) as Record<string, unknown>;

    expect(context).not.toHaveProperty('patientId');
    expect(context).not.toHaveProperty('appointmentId');
    expect(context).not.toHaveProperty('profileId');
    expect(context).not.toHaveProperty('clinicId');
    expect(context).not.toHaveProperty('createdByUserId');
    expect(context).toHaveProperty('description');
    expect(context).toHaveProperty('availableCategories');
  });

  // ── OpenAI generic error → InternalServerErrorException ───────────────────

  it('throws InternalServerErrorException when OpenAI fails with generic error', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(
      buildTransaction({ description: 'Despesa generica sem keywords' }),
    );
    mockQuota('professional', true, 30, 30);
    (service as unknown as { openai: { chat: { completions: { create: jest.Mock } } } }).openai = {
      chat: { completions: { create: jest.fn().mockRejectedValue(new Error('Network error')) } },
    };

    await expect(
      service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, {}),
    ).rejects.toThrow(InternalServerErrorException);
  });

  // ── OpenAI rate limit → ServiceUnavailableException ───────────────────────

  it('throws ServiceUnavailableException when OpenAI returns rate limit error', async () => {
    mockPrisma.financialTransaction.findFirst.mockResolvedValue(
      buildTransaction({ description: 'Despesa generica sem keywords' }),
    );
    mockQuota('professional', true, 30, 30);
    const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });
    (service as unknown as { openai: { chat: { completions: { create: jest.Mock } } } }).openai = {
      chat: { completions: { create: jest.fn().mockRejectedValue(rateLimitError) } },
    };

    await expect(
      service.classifyExpense(USER_ID, CLINIC_ID, TX_ID, {}),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
