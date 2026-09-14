import {
  ForbiddenException,
  HttpStatus,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AiAssistantAnalysisStatus,
  AiAssistantAnalysisType,
} from '@prisma/client';

import { StockCopilotService } from './stock-copilot.service';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPurchaseListService = {
  getPurchaseList: jest.fn(),
};

const mockRepository = {
  findLatest: jest.fn(),
  saveSuccess: jest.fn(),
  saveError: jest.fn(),
};

const mockQuotaService = {
  getQuota: jest.fn(),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const CLINIC_ID = 'clinic-1';
const USER_ID = 'user-1';
const OTHER_CLINIC_ID = 'clinic-2';

function buildService(): StockCopilotService {
  return new StockCopilotService(
    mockPurchaseListService as never,
    mockRepository as never,
    mockQuotaService as never,
  );
}

function buildPurchaseList(itemCount: number, overrides: object[] = []) {
  const items = Array.from({ length: itemCount }, (_, i) => ({
    productId: `prod-${i}`,
    productName: `Produto ${i}`,
    categoryName: `Categoria ${i}`,
    supplier: `Fornecedor ${i}`,
    currentQuantity: 0,
    minQuantity: 10,
    unit: 'un',
    deficitQuantity: 10,
    suggestedPurchaseQuantity: 15,
    estimatedCostCents: 5000,
    priority: 'CRITICAL',
    reason: 'Estoque zerado',
    ...overrides[i],
  }));

  return {
    summary: {
      totalItems: itemCount,
      criticalItems: itemCount,
      highPriorityItems: 0,
      mediumPriorityItems: 0,
      totalEstimatedCostCents: itemCount * 5000,
    },
    items,
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
    nextResetAt: new Date(Date.UTC(2026, 5, 1)).toISOString(),
    lastGeneratedAt: null,
    blockedReason: allowed
      ? remaining === 0
        ? 'Limite atingido.'
        : null
      : 'Plano não permite.',
  });
}

function mockOpenAi(service: StockCopilotService, response: object): jest.Mock {
  const mockCreate = jest.fn().mockResolvedValue({
    choices: [
      {
        message: {
          content: JSON.stringify(response),
        },
      },
    ],
  });
  (
    service as unknown as {
      openai: { chat: { completions: { create: jest.Mock } } };
    }
  ).openai = {
    chat: { completions: { create: mockCreate } },
  };
  return mockCreate;
}

function mockValidAiResponse() {
  return {
    summary: 'Seu estoque possui 2 itens críticos.',
    highlights: ['2 produtos zerados.', 'Custo estimado R$ 100,00.'],
    recommendedActions: [
      'Comprar itens críticos primeiro.',
      'Atualizar estoque após a compra.',
    ],
  };
}

function todayRecord(content: object) {
  return {
    content,
    generatedAt: new Date(), // today
    status: AiAssistantAnalysisStatus.SUCCESS,
  };
}

function yesterdayRecord(content: object) {
  // Use a fixed past timestamp that is guaranteed to be before any Brazil day start.
  // 2026-05-25T00:00:00Z is well before the Brazil midnight of 2026-05-26 (03:00 UTC).
  const yesterday = new Date('2026-05-25T00:00:00Z');
  return {
    content,
    generatedAt: yesterday,
    status: AiAssistantAnalysisStatus.SUCCESS,
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('StockCopilotService', () => {
  let service: StockCopilotService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRepository.saveSuccess.mockResolvedValue(undefined);
    mockRepository.saveError.mockResolvedValue(undefined);
    mockRepository.findLatest.mockResolvedValue(null);
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_AI_ASSISTANT_ENABLED = 'true';
    service = buildService();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_AI_ASSISTANT_ENABLED;
  });

  // ── 1. Professional allowed ───────────────────────────────────────────────

  it('(1) professional plan: returns AI result when forceRefresh=true', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(2),
    );
    mockQuota('professional', true, 10, 10);
    const mockCreate = mockOpenAi(service, mockValidAiResponse());

    const result = await service.getCopilotSummary(USER_ID, CLINIC_ID, true);

    expect(result).not.toBeNull();
    expect(result!.source).toBe('AI');
    expect(result!.cached).toBe(false);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // ── 2. Premium allowed ───────────────────────────────────────────────────

  it('(2) premium plan: returns AI result with 30-unit quota', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(1),
    );
    mockQuota('premium', true, 30, 30);
    mockOpenAi(service, mockValidAiResponse());

    const result = await service.getCopilotSummary(USER_ID, CLINIC_ID, true);

    expect(result).not.toBeNull();
    expect(result!.source).toBe('AI');
    expect(mockQuotaService.getQuota).toHaveBeenCalledWith(
      CLINIC_ID,
      AiAssistantAnalysisType.STOCK_COPILOT,
    );
  });

  // ── 3. Starter blocked ───────────────────────────────────────────────────

  it('(3) starter plan: throws ForbiddenException regardless of forceRefresh', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(1),
    );
    mockQuota('starter', false, 0, 0);

    await expect(
      service.getCopilotSummary(USER_ID, CLINIC_ID, false),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      service.getCopilotSummary(USER_ID, CLINIC_ID, true),
    ).rejects.toThrow(ForbiddenException);
  });

  // ── 4. Quota enforcement ─────────────────────────────────────────────────

  it('(4) quota exhausted: throws 429 when forceRefresh=true', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(1),
    );
    mockQuota('professional', true, 0, 10);

    try {
      await service.getCopilotSummary(USER_ID, CLINIC_ID, true);
      throw new Error('Expected exception not thrown');
    } catch (err: unknown) {
      expect((err as { getStatus?: () => number }).getStatus?.()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  });

  it('(4) quota exhausted but cache hit: returns cache without throwing', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(1),
    );
    mockQuota('professional', true, 0, 10);
    mockRepository.findLatest.mockResolvedValue(
      todayRecord(mockValidAiResponse()),
    );

    const result = await service.getCopilotSummary(USER_ID, CLINIC_ID, false);

    expect(result).not.toBeNull();
    expect(result!.source).toBe('CACHE');
  });

  // ── 5. Cache hit does not call AI ────────────────────────────────────────

  it('(5) same-day cache hit: returns cached result without calling OpenAI', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(1),
    );
    mockQuota('professional', true, 10, 10);
    mockRepository.findLatest.mockResolvedValue(
      todayRecord(mockValidAiResponse()),
    );
    const mockCreate = mockOpenAi(service, mockValidAiResponse());

    const result = await service.getCopilotSummary(USER_ID, CLINIC_ID, false);

    expect(result!.source).toBe('CACHE');
    expect(result!.cached).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('(5) any-date cache: returns cached result even when generated on a previous day', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(1),
    );
    mockQuota('professional', true, 10, 10);
    mockRepository.findLatest.mockResolvedValue(
      yesterdayRecord(mockValidAiResponse()),
    );
    const mockCreate = mockOpenAi(service, mockValidAiResponse());

    const result = await service.getCopilotSummary(USER_ID, CLINIC_ID, false);

    expect(result).not.toBeNull();
    expect(result!.source).toBe('CACHE');
    expect(result!.cached).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ── 6. forceRefresh calls AI again ──────────────────────────────────────

  it('(6) forceRefresh=true: calls AI even when same-day cache exists', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(1),
    );
    mockQuota('professional', true, 10, 10);
    mockRepository.findLatest.mockResolvedValue(
      todayRecord(mockValidAiResponse()),
    );
    const mockCreate = mockOpenAi(service, mockValidAiResponse());

    const result = await service.getCopilotSummary(USER_ID, CLINIC_ID, true);

    expect(result!.source).toBe('AI');
    expect(result!.cached).toBe(false);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // ── 7. AI context max 10 items ──────────────────────────────────────────

  it('(7) AI context is capped at 10 items even when purchase list has more', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(15),
    );
    mockQuota('professional', true, 10, 10);

    let capturedContext: unknown = null;
    const mockCreate = jest.fn().mockImplementation((params: unknown) => {
      capturedContext = params;
      return Promise.resolve({
        choices: [
          { message: { content: JSON.stringify(mockValidAiResponse()) } },
        ],
      });
    });
    (
      service as unknown as {
        openai: { chat: { completions: { create: jest.Mock } } };
      }
    ).openai = {
      chat: { completions: { create: mockCreate } },
    };

    await service.getCopilotSummary(USER_ID, CLINIC_ID, true);

    const messages = (
      capturedContext as { messages: Array<{ role: string; content: string }> }
    ).messages;
    const userContent = JSON.parse(
      messages.find((m) => m.role === 'user')!.content,
    ) as { purchaseList: { items: unknown[] } };
    expect(userContent.purchaseList.items).toHaveLength(10);
  });

  // ── 8. AI context excludes sensitive fields ──────────────────────────────

  it('(8) AI context excludes supplier, categoryName, productId and unit', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(1),
    );
    mockQuota('professional', true, 10, 10);

    let capturedContext: unknown = null;
    const mockCreate = jest.fn().mockImplementation((params: unknown) => {
      capturedContext = params;
      return Promise.resolve({
        choices: [
          { message: { content: JSON.stringify(mockValidAiResponse()) } },
        ],
      });
    });
    (
      service as unknown as {
        openai: { chat: { completions: { create: jest.Mock } } };
      }
    ).openai = {
      chat: { completions: { create: mockCreate } },
    };

    await service.getCopilotSummary(USER_ID, CLINIC_ID, true);

    const messages = (
      capturedContext as { messages: Array<{ role: string; content: string }> }
    ).messages;
    const userContent = JSON.parse(
      messages.find((m) => m.role === 'user')!.content,
    ) as { purchaseList: { items: Array<Record<string, unknown>> } };
    const item = userContent.purchaseList.items[0];

    expect(item).not.toHaveProperty('supplier');
    expect(item).not.toHaveProperty('categoryName');
    expect(item).not.toHaveProperty('productId');
    expect(item).not.toHaveProperty('unit');
    expect(item).toHaveProperty('productName');
    expect(item).toHaveProperty('priority');
    expect(item).toHaveProperty('currentQuantity');
    expect(item).toHaveProperty('minQuantity');
    expect(item).toHaveProperty('suggestedPurchaseQuantity');
    expect(item).toHaveProperty('reason');
  });

  // ── 9. Empty purchase list skips AI ─────────────────────────────────────

  it('(9) empty purchase list: returns null without calling quota or AI', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(0),
    );
    const mockCreate = mockOpenAi(service, mockValidAiResponse());

    const result = await service.getCopilotSummary(USER_ID, CLINIC_ID, true);

    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockQuotaService.getQuota).not.toHaveBeenCalled();
  });

  // ── 10. AI provider error returns friendly error ─────────────────────────

  it('(10) OpenAI network error: throws InternalServerErrorException', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(1),
    );
    mockQuota('professional', true, 10, 10);

    const mockCreate = jest.fn().mockRejectedValue(new Error('network error'));
    (
      service as unknown as {
        openai: { chat: { completions: { create: jest.Mock } } };
      }
    ).openai = {
      chat: { completions: { create: mockCreate } },
    };

    await expect(
      service.getCopilotSummary(USER_ID, CLINIC_ID, true),
    ).rejects.toThrow(InternalServerErrorException);
  });

  it('(10) OpenAI rate limit (429): throws ServiceUnavailableException', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(1),
    );
    mockQuota('professional', true, 10, 10);

    const rateLimitError = Object.assign(new Error('rate limit'), {
      status: 429,
    });
    const mockCreate = jest.fn().mockRejectedValue(rateLimitError);
    (
      service as unknown as {
        openai: { chat: { completions: { create: jest.Mock } } };
      }
    ).openai = {
      chat: { completions: { create: mockCreate } },
    };

    await expect(
      service.getCopilotSummary(USER_ID, CLINIC_ID, true),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  // ── 11. Tenant isolation ─────────────────────────────────────────────────

  it('(11) tenant isolation: findLatest is called with the correct clinicId', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(1),
    );
    mockQuota('professional', true, 10, 10);
    mockRepository.findLatest.mockResolvedValue(null);

    await service.getCopilotSummary(USER_ID, OTHER_CLINIC_ID, false);

    expect(mockRepository.findLatest).toHaveBeenCalledWith(
      OTHER_CLINIC_ID,
      AiAssistantAnalysisType.STOCK_COPILOT,
    );
    expect(mockRepository.findLatest).not.toHaveBeenCalledWith(
      CLINIC_ID,
      expect.anything(),
    );
  });

  it('(11) tenant isolation: quota is checked for the correct clinicId', async () => {
    mockPurchaseListService.getPurchaseList.mockResolvedValue(
      buildPurchaseList(1),
    );
    mockQuota('professional', true, 10, 10);

    await service.getCopilotSummary(USER_ID, OTHER_CLINIC_ID, false);

    expect(mockQuotaService.getQuota).toHaveBeenCalledWith(
      OTHER_CLINIC_ID,
      AiAssistantAnalysisType.STOCK_COPILOT,
    );
  });
});

// ── getLatestAnalysis ─────────────────────────────────────────────────────────
//
// Returns the last persisted DB record regardless of current purchase-list state.
// This is the endpoint used on page mount so analyses survive empty-list cycles.

describe('StockCopilotService.getLatestAnalysis', () => {
  let service: StockCopilotService;

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
    mockRepository.findLatest.mockResolvedValue(null);

    const result = await service.getLatestAnalysis(CLINIC_ID);

    expect(result).toBeNull();
    expect(mockRepository.findLatest).toHaveBeenCalledWith(
      CLINIC_ID,
      AiAssistantAnalysisType.STOCK_COPILOT,
    );
  });

  it('returns persisted record even when purchase list is currently empty', async () => {
    // Simulates the key bug: purchase list is empty today, but a previous
    // analysis was generated yesterday.  getCopilotSummary would short-circuit
    // and return null; getLatestAnalysis bypasses that check.
    mockQuota('professional', true, 10, 10);
    const storedContent = mockValidAiResponse();
    const generatedAt = new Date('2026-06-01T14:00:00Z');
    mockRepository.findLatest.mockResolvedValue({
      content: storedContent,
      generatedAt,
      status: 'SUCCESS' as const,
    });

    // Note: getPurchaseList is NOT called — the purchase list check is bypassed
    const result = await service.getLatestAnalysis(CLINIC_ID);

    expect(result).not.toBeNull();
    expect(result!.summary).toBe(storedContent.summary);
    expect(result!.generatedAt).toBe(generatedAt.toISOString());
    expect(result!.source).toBe('CACHE');
    expect(result!.cached).toBe(true);
    expect(mockPurchaseListService.getPurchaseList).not.toHaveBeenCalled();
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
      AiAssistantAnalysisType.STOCK_COPILOT,
    );
    expect(mockRepository.findLatest).not.toHaveBeenCalledWith(
      CLINIC_ID,
      expect.anything(),
    );
  });

  it('does not include purchaseListSnapshot in the response', async () => {
    mockQuota('professional', true, 10, 10);
    mockRepository.findLatest.mockResolvedValue({
      content: mockValidAiResponse(),
      generatedAt: new Date(),
      status: 'SUCCESS' as const,
    });

    const result = await service.getLatestAnalysis(CLINIC_ID);

    expect(result).not.toHaveProperty('purchaseListSnapshot');
  });
});
