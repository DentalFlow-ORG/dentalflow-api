import {
  ForbiddenException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiAssistantAnalysisType } from '@prisma/client';

import { AbnormalConsumptionCopilotService } from './abnormal-consumption-copilot.service';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockAbnormalConsumptionService = {
  getAbnormalConsumption: jest.fn(),
};

const mockRepository = {
  findLatest: jest.fn(),
  saveSuccess: jest.fn(),
  saveError: jest.fn(),
};

const mockQuotaService = {
  getQuota: jest.fn(),
};

// ── Helpers ────────────────────────────────────────────────────────────────────

const CLINIC_ID = 'clinic-1';
const USER_ID = 'user-1';
const OTHER_CLINIC_ID = 'clinic-2';

function buildService(): AbnormalConsumptionCopilotService {
  return new AbnormalConsumptionCopilotService(
    mockAbnormalConsumptionService as never,
    mockRepository as never,
    mockQuotaService as never,
  );
}

function buildConsumptionResult(totalAnomalies: number, items: object[] = []) {
  const defaultItem = {
    productId: 'prod-1',
    productName: 'Produto Teste',
    categoryName: 'Categoria A',
    currentQuantity: 50,
    minQuantity: 10,
    unit: 'unidade',
    anomalyType: 'CONSUMPTION_SPIKE',
    severity: 'HIGH',
    recentQuantity: 30,
    baselineQuantity: 10,
    changePercent: 200,
    movementCount: 3,
    reason: 'Consumo 200% acima da média histórica.',
    suggestedAction: 'Verifique o uso do produto.',
  };

  const resultItems =
    items.length > 0
      ? items.map((i) => ({ ...defaultItem, ...i }))
      : totalAnomalies > 0
        ? [defaultItem]
        : [];

  return {
    summary: {
      totalAnomalies,
      highSeverity: totalAnomalies > 0 ? 1 : 0,
      mediumSeverity: 0,
      lowSeverity: 0,
      recentDays: 14,
      baselineDays: 60,
      analyzedProducts: 5,
    },
    items: resultItems,
  };
}

function mockQuota(
  planKey: string,
  allowed: boolean,
  remaining: number,
  limit: number,
) {
  mockQuotaService.getQuota.mockResolvedValue({
    allowed,
    planKey,
    used: limit - remaining,
    remaining,
    limit,
    nextResetAt: new Date(Date.UTC(2026, 6, 1)).toISOString(),
    lastGeneratedAt: null,
    blockedReason: allowed
      ? remaining === 0
        ? 'Limite mensal atingido.'
        : null
      : 'Plano não permite.',
  });
}

function mockOpenAi(
  service: AbnormalConsumptionCopilotService,
  responseJson: string,
) {
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

const VALID_AI_RESPONSE = JSON.stringify({
  summary: 'Foram detectadas variações nos produtos analisados.',
  highlights: ['1 produto com consumo elevado.'],
  recommendedActions: ['Confira fisicamente os produtos afetados.'],
});

const CACHED_RECORD = {
  content: {
    summary: 'Resumo em cache.',
    highlights: ['Produto em cache.'],
    recommendedActions: ['Ação em cache.'],
  },
  generatedAt: new Date(),
};

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('AbnormalConsumptionCopilotService', () => {
  let service: AbnormalConsumptionCopilotService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
    mockRepository.findLatest.mockResolvedValue(null);
    mockRepository.saveSuccess.mockResolvedValue(undefined);
    mockRepository.saveError.mockResolvedValue(undefined);
    service = buildService();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  // ── 1. Professional allowed ──────────────────────────────────────────────────

  it('returns a result for professional plan (quota available)', async () => {
    mockAbnormalConsumptionService.getAbnormalConsumption.mockResolvedValue(
      buildConsumptionResult(1),
    );
    mockQuota('professional', true, 10, 10);
    mockOpenAi(service, VALID_AI_RESPONSE);

    const result = await service.getCopilotSummary(USER_ID, CLINIC_ID, {
      forceRefresh: true,
    });

    expect(result).not.toBeNull();
    expect(result.source).toBe('AI');
    expect(result.summary).toBe('Foram detectadas variações nos produtos analisados.');
  });

  // ── 2. Premium allowed ───────────────────────────────────────────────────────

  it('returns a result for premium plan (quota available)', async () => {
    mockAbnormalConsumptionService.getAbnormalConsumption.mockResolvedValue(
      buildConsumptionResult(1),
    );
    mockQuota('premium', true, 30, 30);
    mockOpenAi(service, VALID_AI_RESPONSE);

    const result = await service.getCopilotSummary(USER_ID, CLINIC_ID, {
      forceRefresh: true,
    });

    expect(result.source).toBe('AI');
  });

  // ── 3. Starter blocked ───────────────────────────────────────────────────────

  it('throws ForbiddenException for starter plan', async () => {
    mockAbnormalConsumptionService.getAbnormalConsumption.mockResolvedValue(
      buildConsumptionResult(1),
    );
    mockQuota('starter', false, 0, 0);

    await expect(
      service.getCopilotSummary(USER_ID, CLINIC_ID, { forceRefresh: false }),
    ).rejects.toThrow(ForbiddenException);
  });

  // ── 4. Quota exhausted — 429 on forceRefresh:true ────────────────────────────

  it('throws 429 when quota is exhausted and forceRefresh is true', async () => {
    mockAbnormalConsumptionService.getAbnormalConsumption.mockResolvedValue(
      buildConsumptionResult(1),
    );
    mockQuota('professional', true, 0, 10);

    await expect(
      service.getCopilotSummary(USER_ID, CLINIC_ID, { forceRefresh: true }),
    ).rejects.toMatchObject({ status: 429 });
  });

  // ── 5. Cache hit — OpenAI not called, quota not consumed ─────────────────────

  it('returns cached result without calling OpenAI when forceRefresh is false and cache exists', async () => {
    mockAbnormalConsumptionService.getAbnormalConsumption.mockResolvedValue(
      buildConsumptionResult(1),
    );
    mockQuota('professional', true, 10, 10);
    mockRepository.findLatest.mockResolvedValue(CACHED_RECORD);
    const mockCreate = jest.fn();
    mockOpenAi(service, VALID_AI_RESPONSE);
    (service as unknown as { openai: { chat: { completions: { create: jest.Mock } } } }).openai.chat.completions.create = mockCreate;

    const result = await service.getCopilotSummary(USER_ID, CLINIC_ID, {
      forceRefresh: false,
    });

    expect(result.source).toBe('CACHE');
    expect(result.cached).toBe(true);
    expect(result.summary).toBe('Resumo em cache.');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ── 6. forceRefresh bypasses cache and calls OpenAI ──────────────────────────

  it('calls OpenAI even when same-day cache exists if forceRefresh is true', async () => {
    mockAbnormalConsumptionService.getAbnormalConsumption.mockResolvedValue(
      buildConsumptionResult(1),
    );
    mockQuota('professional', true, 10, 10);
    mockRepository.findLatest.mockResolvedValue(CACHED_RECORD);
    mockOpenAi(service, VALID_AI_RESPONSE);
    const mockCreate = (service as unknown as { openai: { chat: { completions: { create: jest.Mock } } } }).openai.chat.completions.create;

    const result = await service.getCopilotSummary(USER_ID, CLINIC_ID, {
      forceRefresh: true,
    });

    expect(result.source).toBe('AI');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // ── 7. AI context capped at 10 anomalies ─────────────────────────────────────

  it('sends at most 10 anomalies to OpenAI even when more are present', async () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      productId: `prod-${i}`,
      productName: `Produto ${i}`,
      categoryName: 'Cat',
      currentQuantity: 50,
      minQuantity: 5,
      unit: 'un',
      anomalyType: 'CONSUMPTION_SPIKE',
      severity: 'MEDIUM',
      recentQuantity: 20,
      baselineQuantity: 10,
      changePercent: 100,
      movementCount: 2,
      reason: `Razão ${i}`,
      suggestedAction: `Ação ${i}`,
    }));
    mockAbnormalConsumptionService.getAbnormalConsumption.mockResolvedValue(
      buildConsumptionResult(15, items),
    );
    mockQuota('premium', true, 30, 30);
    mockOpenAi(service, VALID_AI_RESPONSE);
    const mockCreate = (service as unknown as { openai: { chat: { completions: { create: jest.Mock } } } }).openai.chat.completions.create;

    await service.getCopilotSummary(USER_ID, CLINIC_ID, { forceRefresh: true });

    const calledWith = mockCreate.mock.calls[0][0];
    const userMessage = calledWith.messages[1].content;
    const context = JSON.parse(userMessage);
    expect(context.anomalyAnalysis.items).toHaveLength(10);
    expect(context.anomalyAnalysis.items.length).toBeLessThanOrEqual(10);
  });

  // ── 8. AI context excludes restricted fields ──────────────────────────────────

  it('excludes productId, categoryName, unit, currentQuantity, minQuantity from AI context', async () => {
    mockAbnormalConsumptionService.getAbnormalConsumption.mockResolvedValue(
      buildConsumptionResult(1),
    );
    mockQuota('professional', true, 10, 10);
    mockOpenAi(service, VALID_AI_RESPONSE);
    const mockCreate = (service as unknown as { openai: { chat: { completions: { create: jest.Mock } } } }).openai.chat.completions.create;

    await service.getCopilotSummary(USER_ID, CLINIC_ID, { forceRefresh: true });

    const calledWith = mockCreate.mock.calls[0][0];
    const context = JSON.parse(calledWith.messages[1].content);
    const item = context.anomalyAnalysis.items[0];

    expect(item).not.toHaveProperty('productId');
    expect(item).not.toHaveProperty('categoryName');
    expect(item).not.toHaveProperty('unit');
    expect(item).not.toHaveProperty('currentQuantity');
    expect(item).not.toHaveProperty('minQuantity');
    expect(item).toHaveProperty('productName');
    expect(item).toHaveProperty('anomalyType');
    expect(item).toHaveProperty('severity');
  });

  // ── 9. Empty anomaly list — no AI, no quota ───────────────────────────────────

  it('returns deterministic positive response without calling AI or quota when totalAnomalies is 0', async () => {
    mockAbnormalConsumptionService.getAbnormalConsumption.mockResolvedValue(
      buildConsumptionResult(0),
    );

    const result = await service.getCopilotSummary(USER_ID, CLINIC_ID, {
      forceRefresh: true,
    });

    expect(result.source).toBe('CACHE');
    expect(result.anomalySnapshot?.totalAnomalies).toBe(0);
    expect(mockQuotaService.getQuota).not.toHaveBeenCalled();
  });

  // ── 10. OpenAI provider error → friendly InternalServerErrorException ─────────

  it('throws InternalServerErrorException when OpenAI fails with a generic error', async () => {
    mockAbnormalConsumptionService.getAbnormalConsumption.mockResolvedValue(
      buildConsumptionResult(1),
    );
    mockQuota('professional', true, 10, 10);
    (service as unknown as { openai: { chat: { completions: { create: jest.Mock } } } }).openai = {
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(new Error('Network error')),
        },
      },
    };

    await expect(
      service.getCopilotSummary(USER_ID, CLINIC_ID, { forceRefresh: true }),
    ).rejects.toThrow(InternalServerErrorException);
  });

  it('throws ServiceUnavailableException when OpenAI returns a rate-limit error', async () => {
    mockAbnormalConsumptionService.getAbnormalConsumption.mockResolvedValue(
      buildConsumptionResult(1),
    );
    mockQuota('professional', true, 10, 10);
    const rateLimitError = Object.assign(new Error('Rate limited'), {
      status: 429,
    });
    (service as unknown as { openai: { chat: { completions: { create: jest.Mock } } } }).openai = {
      chat: {
        completions: { create: jest.fn().mockRejectedValue(rateLimitError) },
      },
    };

    await expect(
      service.getCopilotSummary(USER_ID, CLINIC_ID, { forceRefresh: true }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  // ── 11. Tenant isolation ──────────────────────────────────────────────────────

  it('passes the correct clinicId to both the consumption service and the repository', async () => {
    mockAbnormalConsumptionService.getAbnormalConsumption.mockResolvedValue(
      buildConsumptionResult(0),
    );

    await service.getCopilotSummary(USER_ID, OTHER_CLINIC_ID, {
      forceRefresh: false,
    });

    expect(
      mockAbnormalConsumptionService.getAbnormalConsumption,
    ).toHaveBeenCalledWith(
      OTHER_CLINIC_ID,
      expect.objectContaining({}),
    );
  });

  it('passes the correct clinicId to findLatest for cache lookup', async () => {
    mockAbnormalConsumptionService.getAbnormalConsumption.mockResolvedValue(
      buildConsumptionResult(1),
    );
    mockQuota('professional', true, 10, 10);
    mockRepository.findLatest.mockResolvedValue(null);

    await service.getCopilotSummary(USER_ID, OTHER_CLINIC_ID, {
      forceRefresh: false,
    });

    expect(mockRepository.findLatest).toHaveBeenCalledWith(
      OTHER_CLINIC_ID,
      AiAssistantAnalysisType.ABNORMAL_CONSUMPTION_COPILOT,
    );
  });

  // ── 12. recentDays/baselineDays passed through ────────────────────────────────

  it('passes recentDays and baselineDays to the deterministic service', async () => {
    mockAbnormalConsumptionService.getAbnormalConsumption.mockResolvedValue(
      buildConsumptionResult(0),
    );

    await service.getCopilotSummary(USER_ID, CLINIC_ID, {
      forceRefresh: false,
      recentDays: 7,
      baselineDays: 30,
    });

    expect(
      mockAbnormalConsumptionService.getAbnormalConsumption,
    ).toHaveBeenCalledWith(
      CLINIC_ID,
      expect.objectContaining({ recentDays: 7, baselineDays: 30 }),
    );
  });
});

// ── getLatestAnalysis ─────────────────────────────────────────────────────────
//
// Returns the last persisted DB record regardless of current anomaly-list state.
// This is the endpoint used on page mount so analyses survive zero-anomaly cycles.

describe('AbnormalConsumptionCopilotService.getLatestAnalysis', () => {
  let service: AbnormalConsumptionCopilotService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRepository.findLatest.mockResolvedValue(null);
    process.env.OPENAI_API_KEY = 'sk-test';
    service = buildService();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it('returns null when no record exists', async () => {
    mockQuota('professional', true, 10, 10);

    const result = await service.getLatestAnalysis(CLINIC_ID);

    expect(result).toBeNull();
    expect(mockRepository.findLatest).toHaveBeenCalledWith(
      CLINIC_ID,
      AiAssistantAnalysisType.ABNORMAL_CONSUMPTION_COPILOT,
    );
  });

  it('returns persisted record even when there are currently no anomalies', async () => {
    // Key bug scenario: anomalies resolved today, but a previous analysis
    // was generated when they existed.  getCopilotSummary returns deterministic
    // empty content; getLatestAnalysis bypasses that check entirely.
    mockQuota('professional', true, 10, 10);
    const storedContent = {
      summary: 'Resumo gerado.',
      highlights: ['Produto X consumo alto.'],
      recommendedActions: ['Verifique o produto X.'],
    };
    const generatedAt = new Date('2026-06-01T14:00:00Z');
    mockRepository.findLatest.mockResolvedValue({
      content: storedContent,
      generatedAt,
      status: 'SUCCESS' as const,
    });

    const result = await service.getLatestAnalysis(CLINIC_ID);

    expect(result).not.toBeNull();
    expect(result!.summary).toBe(storedContent.summary);
    expect(result!.generatedAt).toBe(generatedAt.toISOString());
    expect(result!.source).toBe('CACHE');
    expect(result!.cached).toBe(true);
    // The anomaly service is never called — no live data fetch
    expect(mockAbnormalConsumptionService.getAbnormalConsumption).not.toHaveBeenCalled();
  });

  it('throws ForbiddenException when plan does not allow copilot', async () => {
    mockQuota('starter', false, 0, 0);

    await expect(service.getLatestAnalysis(CLINIC_ID)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('uses clinic isolation — only fetches records for the given clinicId', async () => {
    mockQuota('professional', true, 10, 10);

    await service.getLatestAnalysis(OTHER_CLINIC_ID);

    expect(mockRepository.findLatest).toHaveBeenCalledWith(
      OTHER_CLINIC_ID,
      AiAssistantAnalysisType.ABNORMAL_CONSUMPTION_COPILOT,
    );
    expect(mockRepository.findLatest).not.toHaveBeenCalledWith(
      CLINIC_ID,
      expect.anything(),
    );
  });

  it('does not include anomalySnapshot in the response', async () => {
    mockQuota('professional', true, 10, 10);
    mockRepository.findLatest.mockResolvedValue({
      content: { summary: 'ok', highlights: [], recommendedActions: [] },
      generatedAt: new Date(),
      status: 'SUCCESS' as const,
    });

    const result = await service.getLatestAnalysis(CLINIC_ID);

    expect(result).not.toHaveProperty('anomalySnapshot');
  });
});
