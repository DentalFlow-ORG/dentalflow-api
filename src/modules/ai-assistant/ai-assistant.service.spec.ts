import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AiAssistantService } from './ai-assistant.service';

/**
 * The AI assistant: plan gating, data readiness, and everything that can come
 * back from OpenAI.
 *
 * Three properties matter. It must never call the provider when the clinic is
 * not entitled or the data is too thin to analyse — every call costs money.
 * The model's output is untrusted input, so it is validated and truncated
 * rather than passed through. And no failure path may leak a provider error
 * message or an API key to the caller.
 *
 * No test here reaches OpenAI: the client is replaced wholesale.
 */

const CLINIC = 'clinic-1';
const USER = 'user-1';

/** A well-formed model response. */
const VALID_COMPLETION = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          sections: [
            { title: 'Receita', content: 'Cresceu 12%.', tone: 'positive' },
          ],
          disclaimer: 'Revise antes de decidir.',
        }),
      },
    },
  ],
};

function createDeps() {
  return {
    financeContextBuilder: {
      build: jest.fn().mockResolvedValue({
        generatedAt: '2026-06-15T00:00:00.000Z',
        period: { from: '2026-06-01', to: '2026-06-30' },
      }),
    },
    inventoryContextBuilder: {
      build: jest.fn().mockResolvedValue({
        generatedAt: '2026-06-15T00:00:00.000Z',
      }),
    },
    analysisRepository: {
      findLatest: jest.fn().mockResolvedValue(null),
      saveSuccess: jest.fn().mockResolvedValue({}),
      saveError: jest.fn().mockResolvedValue({}),
    },
    quotaService: {
      assertQuota: jest.fn().mockResolvedValue(undefined),
      getQuota: jest.fn().mockResolvedValue({ allowed: true }),
    },
    prisma: {
      financialTransaction: { groupBy: jest.fn().mockResolvedValue([]) },
      stockMovement: { findMany: jest.fn().mockResolvedValue([]) },
      stockProduct: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    },
  };
}

/** 30 distinct days of income — enough for the finance readiness gate. */
function enoughFinanceDays() {
  return Array.from({ length: 30 }, (_, i) => ({
    transactionDate: new Date(Date.UTC(2026, 5, i + 1)),
  }));
}

describe('AiAssistantService', () => {
  let deps: ReturnType<typeof createDeps>;
  let service: AiAssistantService;
  let openai: { chat: { completions: { create: jest.Mock } } };
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, OPENAI_API_KEY: 'sk-test-key' };
    delete process.env.OPENAI_AI_ASSISTANT_ENABLED;
    delete process.env.OPENAI_MODEL;
    delete process.env.OPENAI_AI_MAX_OUTPUT_TOKENS;

    deps = createDeps();
    service = new AiAssistantService(
      deps.financeContextBuilder as never,
      deps.inventoryContextBuilder as never,
      deps.analysisRepository as never,
      deps.quotaService as never,
      deps.prisma as never,
    );

    // Replace the real client outright — nothing here may reach OpenAI.
    openai = { chat: { completions: { create: jest.fn() } } };
    (service as unknown as { openai: typeof openai }).openai = openai;

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  /** Makes the finance readiness gate pass. */
  function financeDataReady() {
    deps.prisma.financialTransaction.groupBy.mockResolvedValue(
      enoughFinanceDays(),
    );
  }

  // ── Configuration reporting ────────────────────────────────────────────────

  describe('getConfigStatus', () => {
    it('reports ready with a properly formatted key', () => {
      expect(service.getConfigStatus()).toMatchObject({
        enabled: true,
        hasApiKey: true,
        ready: true,
      });
    });

    it('reports not ready when the key is missing', () => {
      delete process.env.OPENAI_API_KEY;

      expect(service.getConfigStatus()).toMatchObject({
        hasApiKey: false,
        ready: false,
      });
    });

    it('rejects a key that does not look like an OpenAI key', () => {
      // A pasted placeholder or truncated value would otherwise be reported
      // as configured and fail only at call time.
      process.env.OPENAI_API_KEY = 'not-a-real-key';

      expect(service.getConfigStatus().hasApiKey).toBe(false);
    });

    it('reports not ready when the assistant is explicitly disabled', () => {
      process.env.OPENAI_AI_ASSISTANT_ENABLED = 'false';

      expect(service.getConfigStatus()).toMatchObject({
        enabled: false,
        ready: false,
      });
    });

    it('treats any value other than "false" as enabled', () => {
      process.env.OPENAI_AI_ASSISTANT_ENABLED = 'no';

      expect(service.getConfigStatus().enabled).toBe(true);
    });

    it('reports whether the model and token budget were configured explicitly', () => {
      expect(service.getConfigStatus()).toMatchObject({
        modelConfigured: false,
        maxOutputTokensConfigured: false,
      });

      process.env.OPENAI_MODEL = 'gpt-4o-mini';
      process.env.OPENAI_AI_MAX_OUTPUT_TOKENS = '900';
      expect(service.getConfigStatus()).toMatchObject({
        modelConfigured: true,
        maxOutputTokensConfigured: true,
      });
    });

    it('rejects a non-numeric or non-positive token budget', () => {
      process.env.OPENAI_AI_MAX_OUTPUT_TOKENS = 'many';
      expect(service.getConfigStatus().maxOutputTokensConfigured).toBe(false);

      process.env.OPENAI_AI_MAX_OUTPUT_TOKENS = '0';
      expect(service.getConfigStatus().maxOutputTokensConfigured).toBe(false);
    });

    it('never returns the key itself', () => {
      expect(JSON.stringify(service.getConfigStatus())).not.toContain(
        'sk-test-key',
      );
    });
  });

  // ── Gating: nothing costs money until it should ────────────────────────────

  describe('gating', () => {
    it('refuses to analyse when the assistant is disabled', async () => {
      process.env.OPENAI_AI_ASSISTANT_ENABLED = 'false';

      await expect(service.analyzeFinance(USER, CLINIC)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(openai.chat.completions.create).not.toHaveBeenCalled();
    });

    it('refuses to analyse with no API key', async () => {
      delete process.env.OPENAI_API_KEY;

      await expect(service.analyzeFinance(USER, CLINIC)).rejects.toThrow(
        /indisponível/,
      );
      expect(openai.chat.completions.create).not.toHaveBeenCalled();
    });

    it('checks the plan quota before doing anything else', async () => {
      deps.quotaService.assertQuota.mockRejectedValue(
        new BadRequestException('Limite de análises atingido'),
      );

      await expect(service.analyzeFinance(USER, CLINIC)).rejects.toThrow(
        /Limite de análises/,
      );
      expect(deps.financeContextBuilder.build).not.toHaveBeenCalled();
      expect(openai.chat.completions.create).not.toHaveBeenCalled();
    });

    it('refuses when the clinic has too little financial history', async () => {
      deps.prisma.financialTransaction.groupBy.mockResolvedValue([
        { transactionDate: new Date() },
      ]);

      await expect(service.analyzeFinance(USER, CLINIC)).rejects.toThrow(
        /dados suficientes/,
      );
      expect(openai.chat.completions.create).not.toHaveBeenCalled();
    });

    it('proceeds once there is enough financial history', async () => {
      financeDataReady();
      openai.chat.completions.create.mockResolvedValue(VALID_COMPLETION);

      await expect(service.analyzeFinance(USER, CLINIC)).resolves.toBeDefined();
      expect(openai.chat.completions.create).toHaveBeenCalled();
    });

    it('refuses inventory analysis with too few active days', async () => {
      await expect(service.analyzeInventory(USER, CLINIC)).rejects.toThrow(
        /dados suficientes/,
      );
    });

    it('refuses inventory analysis when the clinic has no active products', async () => {
      // Plenty of movement history, but nothing left in stock to analyse.
      deps.prisma.stockMovement.findMany.mockResolvedValue(
        Array.from({ length: 25 }, (_, i) => ({
          createdAt: new Date(Date.UTC(2026, 5, i + 1)),
        })),
      );
      deps.prisma.stockProduct.count.mockResolvedValue(0);

      await expect(service.analyzeInventory(USER, CLINIC)).rejects.toThrow(
        /dados suficientes/,
      );
    });

    it('counts a day as active from either a movement or a product change', async () => {
      deps.prisma.stockMovement.findMany.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({
          createdAt: new Date(Date.UTC(2026, 5, i + 1)),
        })),
      );
      deps.prisma.stockProduct.findMany.mockResolvedValue(
        Array.from({ length: 15 }, (_, i) => ({
          updatedAt: new Date(Date.UTC(2026, 5, i + 11)),
        })),
      );
      deps.prisma.stockProduct.count.mockResolvedValue(4);
      openai.chat.completions.create.mockResolvedValue(VALID_COMPLETION);

      await expect(
        service.analyzeInventory(USER, CLINIC),
      ).resolves.toBeDefined();
    });

    it('does not double-count two changes on the same day', async () => {
      const sameDay = new Date(Date.UTC(2026, 5, 1));
      deps.prisma.stockMovement.findMany.mockResolvedValue(
        Array.from({ length: 40 }, () => ({ createdAt: sameDay })),
      );
      deps.prisma.stockProduct.count.mockResolvedValue(4);

      await expect(service.analyzeInventory(USER, CLINIC)).rejects.toThrow(
        /dados suficientes/,
      );
    });
  });

  // ── Provider request ───────────────────────────────────────────────────────

  describe('the request sent to OpenAI', () => {
    beforeEach(() => {
      financeDataReady();
      openai.chat.completions.create.mockResolvedValue(VALID_COMPLETION);
    });

    it('asks for a JSON object so the response can be parsed', async () => {
      await service.analyzeFinance(USER, CLINIC);

      expect(openai.chat.completions.create.mock.calls[0][0]).toMatchObject({
        response_format: { type: 'json_object' },
      });
    });

    it('caps the output tokens', async () => {
      await service.analyzeFinance(USER, CLINIC);

      expect(
        openai.chat.completions.create.mock.calls[0][0].max_tokens,
      ).toBeGreaterThan(0);
    });

    it('sends the clinic context as the user message', async () => {
      await service.analyzeFinance(USER, CLINIC);

      const messages = openai.chat.completions.create.mock.calls[0][0].messages;
      expect(messages[0].role).toBe('system');
      expect(messages[1].role).toBe('user');
      expect(JSON.parse(messages[1].content)).toMatchObject({
        period: { from: '2026-06-01', to: '2026-06-30' },
      });
    });

    it('builds the context for the caller’s clinic only', async () => {
      await service.analyzeFinance(USER, CLINIC, '2026-06-01', '2026-06-30');

      expect(deps.financeContextBuilder.build).toHaveBeenCalledWith(
        CLINIC,
        '2026-06-01',
        '2026-06-30',
      );
    });
  });

  // ── Response handling ──────────────────────────────────────────────────────

  describe('response handling', () => {
    beforeEach(financeDataReady);

    function respondWith(content: unknown) {
      openai.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content } }],
      });
    }

    it('returns the parsed sections and disclaimer', async () => {
      openai.chat.completions.create.mockResolvedValue(VALID_COMPLETION);

      const result = await service.analyzeFinance(USER, CLINIC);

      expect(result.sections).toEqual([
        { title: 'Receita', content: 'Cresceu 12%.', tone: 'positive' },
      ]);
      expect(result.disclaimer).toBe('Revise antes de decidir.');
    });

    it('rejects a response that is not JSON', async () => {
      respondWith('I am a helpful assistant, not JSON.');

      await expect(service.analyzeFinance(USER, CLINIC)).rejects.toThrow(
        /formato inválido/,
      );
    });

    it('treats a missing response body as an empty analysis rather than failing', async () => {
      openai.chat.completions.create.mockResolvedValue({ choices: [] });

      const result = await service.analyzeFinance(USER, CLINIC);
      expect(result.sections).toEqual([]);
    });

    it('drops malformed sections instead of passing them through', async () => {
      // The model's output is untrusted input.
      respondWith(
        JSON.stringify({
          sections: [
            { title: 'Boa', content: 'Válida.', tone: 'neutral' },
            { title: 42, content: 'Título não é texto.' },
            'not an object',
            null,
          ],
        }),
      );

      const result = await service.analyzeFinance(USER, CLINIC);
      expect(result.sections).toEqual([
        { title: 'Boa', content: 'Válida.', tone: 'neutral' },
      ]);
    });

    it('caps the number of sections', async () => {
      respondWith(
        JSON.stringify({
          sections: Array.from({ length: 20 }, (_, i) => ({
            title: `Seção ${i}`,
            content: 'Conteúdo',
          })),
        }),
      );

      const result = await service.analyzeFinance(USER, CLINIC);
      expect(result.sections).toHaveLength(6);
    });

    it('truncates an over-long title and body', async () => {
      respondWith(
        JSON.stringify({
          sections: [{ title: 'T'.repeat(500), content: 'C'.repeat(2000) }],
        }),
      );

      const result = await service.analyzeFinance(USER, CLINIC);
      expect(result.sections[0].title).toHaveLength(80);
      expect(result.sections[0].content).toHaveLength(500);
    });

    it('normalises an unrecognised tone to neutral', async () => {
      respondWith(
        JSON.stringify({
          sections: [{ title: 'T', content: 'C', tone: 'apocalyptic' }],
        }),
      );

      const result = await service.analyzeFinance(USER, CLINIC);
      expect(result.sections[0].tone).toBe('neutral');
    });

    it.each(['positive', 'warning', 'danger', 'neutral'])(
      'keeps the recognised tone %s',
      async (tone) => {
        respondWith(
          JSON.stringify({ sections: [{ title: 'T', content: 'C', tone }] }),
        );

        const result = await service.analyzeFinance(USER, CLINIC);
        expect(result.sections[0].tone).toBe(tone);
      },
    );

    it('substitutes a default disclaimer when the model omits one', async () => {
      // Every analysis must carry a disclaimer; the model cannot opt out.
      respondWith(JSON.stringify({ sections: [] }));

      const result = await service.analyzeFinance(USER, CLINIC);
      expect(result.disclaimer).toMatch(/Revise antes de tomar decisões/);
    });

    it('truncates an over-long disclaimer', async () => {
      respondWith(
        JSON.stringify({ sections: [], disclaimer: 'D'.repeat(1000) }),
      );

      const result = await service.analyzeFinance(USER, CLINIC);
      expect(result.disclaimer).toHaveLength(300);
    });

    it('returns an empty list when sections is not an array', async () => {
      respondWith(JSON.stringify({ sections: 'nope' }));

      const result = await service.analyzeFinance(USER, CLINIC);
      expect(result.sections).toEqual([]);
    });
  });

  // ── Failure translation ────────────────────────────────────────────────────

  describe('provider failures', () => {
    beforeEach(financeDataReady);

    it('translates a rate limit into a retryable 503', async () => {
      openai.chat.completions.create.mockRejectedValue({ status: 429 });

      await expect(service.analyzeFinance(USER, CLINIC)).rejects.toThrow(
        ServiceUnavailableException,
      );
      await expect(service.analyzeFinance(USER, CLINIC)).rejects.toThrow(
        /sobrecarregado/,
      );
    });

    it('translates any other provider failure into a generic 500', async () => {
      openai.chat.completions.create.mockRejectedValue(
        new Error('upstream exploded with key sk-test-key'),
      );

      await expect(service.analyzeFinance(USER, CLINIC)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('never leaks the provider message or the API key to the caller', async () => {
      openai.chat.completions.create.mockRejectedValue(
        new Error('upstream exploded with key sk-test-key'),
      );

      await expect(service.analyzeFinance(USER, CLINIC)).rejects.toThrow(
        /Não foi possível gerar a análise/,
      );
      await service.analyzeFinance(USER, CLINIC).catch((err: Error) => {
        expect(err.message).not.toContain('sk-test-key');
        expect(err.message).not.toContain('upstream exploded');
      });
    });

    it('records the failure with a sanitised code, not the raw message', async () => {
      openai.chat.completions.create.mockRejectedValue(
        new Error('secret internal detail'),
      );

      await service.analyzeFinance(USER, CLINIC).catch(() => undefined);

      expect(deps.analysisRepository.saveError).toHaveBeenCalledWith(
        expect.objectContaining({ errorMessage: 'OPENAI_ERROR' }),
      );
    });

    it('records a rate limit distinctly from a generic failure', async () => {
      openai.chat.completions.create.mockRejectedValue({ status: 429 });

      await service.analyzeFinance(USER, CLINIC).catch(() => undefined);

      expect(deps.analysisRepository.saveError).toHaveBeenCalledWith(
        expect.objectContaining({ errorMessage: 'RATE_LIMIT' }),
      );
    });

    it('still reports the failure when recording it also fails', async () => {
      openai.chat.completions.create.mockRejectedValue(new Error('boom'));
      deps.analysisRepository.saveError.mockRejectedValue(new Error('db down'));

      await expect(service.analyzeFinance(USER, CLINIC)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('returns the analysis even when persisting it fails', async () => {
      // The clinician already paid for this call; a storage hiccup must not
      // throw the result away.
      openai.chat.completions.create.mockResolvedValue(VALID_COMPLETION);
      deps.analysisRepository.saveSuccess.mockRejectedValue(
        new Error('db down'),
      );

      const result = await service.analyzeFinance(USER, CLINIC);
      expect(result.sections).toHaveLength(1);
    });
  });

  // ── Persistence ────────────────────────────────────────────────────────────

  describe('persistence', () => {
    beforeEach(() => {
      financeDataReady();
      openai.chat.completions.create.mockResolvedValue(VALID_COMPLETION);
    });

    it('stores the analysis against the clinic and user', async () => {
      await service.analyzeFinance(USER, CLINIC);

      expect(deps.analysisRepository.saveSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          clinicId: CLINIC,
          userId: USER,
          type: 'FINANCE',
        }),
      );
    });

    it('records the analysed period for a finance analysis', async () => {
      await service.analyzeFinance(USER, CLINIC);

      const saved = deps.analysisRepository.saveSuccess.mock.calls[0][0];
      expect(saved.periodStart).toBeInstanceOf(Date);
      expect(saved.periodEnd).toBeInstanceOf(Date);
    });

    it('records no period for an inventory analysis, which has none', async () => {
      deps.prisma.stockMovement.findMany.mockResolvedValue(
        Array.from({ length: 25 }, (_, i) => ({
          createdAt: new Date(Date.UTC(2026, 5, i + 1)),
        })),
      );
      deps.prisma.stockProduct.count.mockResolvedValue(3);

      await service.analyzeInventory(USER, CLINIC);

      const saved = deps.analysisRepository.saveSuccess.mock.calls[0][0];
      expect(saved.type).toBe('INVENTORY');
      expect(saved.periodStart).toBeNull();
    });
  });

  // ── Latest analysis and plan visibility ────────────────────────────────────

  describe('getLatestFinance visibility', () => {
    it('reports INSUFFICIENT_DATA before anything else', async () => {
      const result = await service.getLatestFinance(USER, CLINIC);

      expect(result).toMatchObject({
        visibility: 'INSUFFICIENT_DATA',
        data: null,
      });
      expect(openai.chat.completions.create).not.toHaveBeenCalled();
    });

    it('reports FULL for an entitled clinic', async () => {
      financeDataReady();

      const result = await service.getLatestFinance(USER, CLINIC);
      expect(result.visibility).toBe('FULL');
    });

    it('returns the stored analysis to an entitled clinic', async () => {
      financeDataReady();
      deps.analysisRepository.findLatest.mockResolvedValue({
        content: { sections: [], disclaimer: 'D' },
        model: 'gpt-4o-mini',
        generatedAt: new Date('2026-06-15T00:00:00.000Z'),
        periodStart: null,
        periodEnd: null,
      });

      const result = await service.getLatestFinance(USER, CLINIC);
      expect(result.data).toMatchObject({
        disclaimer: 'D',
        model: 'gpt-4o-mini',
      });
    });

    it('shows a blocked clinic a recent analysis as a teaser', async () => {
      financeDataReady();
      deps.quotaService.getQuota.mockResolvedValue({ allowed: false });
      deps.analysisRepository.findLatest.mockResolvedValue({
        content: { sections: [], disclaimer: 'D' },
        model: 'gpt-4o-mini',
        generatedAt: new Date(),
        periodStart: null,
        periodEnd: null,
      });

      const result = await service.getLatestFinance(USER, CLINIC);

      expect(result.visibility).toBe('TEASER');
      // No new spend for a clinic that is not entitled.
      expect(openai.chat.completions.create).not.toHaveBeenCalled();
    });

    it('generates a teaser for a blocked clinic whose stored analysis is stale', async () => {
      financeDataReady();
      deps.quotaService.getQuota.mockResolvedValue({ allowed: false });
      deps.analysisRepository.findLatest.mockResolvedValue({
        content: { sections: [], disclaimer: 'D' },
        model: 'gpt-4o-mini',
        generatedAt: new Date('2020-01-01T00:00:00.000Z'),
        periodStart: null,
        periodEnd: null,
      });
      openai.chat.completions.create.mockResolvedValue(VALID_COMPLETION);

      const result = await service.getLatestFinance(USER, CLINIC);

      expect(result.visibility).toBe('TEASER');
      expect(openai.chat.completions.create).toHaveBeenCalled();
    });

    it('reports LOCKED for a blocked clinic with nothing stored and no configuration', async () => {
      financeDataReady();
      deps.quotaService.getQuota.mockResolvedValue({ allowed: false });
      delete process.env.OPENAI_API_KEY;

      const result = await service.getLatestFinance(USER, CLINIC);

      expect(result).toMatchObject({ visibility: 'LOCKED', data: null });
      expect(openai.chat.completions.create).not.toHaveBeenCalled();
    });

    it('falls back to the stored analysis when teaser generation fails', async () => {
      financeDataReady();
      deps.quotaService.getQuota.mockResolvedValue({ allowed: false });
      deps.analysisRepository.findLatest.mockResolvedValue({
        content: { sections: [], disclaimer: 'antigo' },
        model: 'gpt-4o-mini',
        generatedAt: new Date('2020-01-01T00:00:00.000Z'),
        periodStart: null,
        periodEnd: null,
      });
      openai.chat.completions.create.mockRejectedValue(
        new Error('provider down'),
      );

      const result = await service.getLatestFinance(USER, CLINIC);

      expect(result.visibility).toBe('TEASER');
      expect(result.data).toMatchObject({ disclaimer: 'antigo' });
    });

    it('reports LOCKED when generation fails and nothing is stored', async () => {
      financeDataReady();
      deps.quotaService.getQuota.mockResolvedValue({ allowed: false });
      openai.chat.completions.create.mockRejectedValue(
        new Error('provider down'),
      );

      const result = await service.getLatestFinance(USER, CLINIC);
      expect(result).toMatchObject({ visibility: 'LOCKED', data: null });
    });
  });

  describe('getLatestInventory visibility', () => {
    function inventoryReady() {
      deps.prisma.stockMovement.findMany.mockResolvedValue(
        Array.from({ length: 25 }, (_, i) => ({
          createdAt: new Date(Date.UTC(2026, 5, i + 1)),
        })),
      );
      deps.prisma.stockProduct.count.mockResolvedValue(3);
    }

    it('reports INSUFFICIENT_DATA when there is too little activity', async () => {
      const result = await service.getLatestInventory(USER, CLINIC);
      expect(result.visibility).toBe('INSUFFICIENT_DATA');
    });

    it('reports FULL for an entitled clinic', async () => {
      inventoryReady();

      const result = await service.getLatestInventory(USER, CLINIC);
      expect(result.visibility).toBe('FULL');
    });

    it('does not spend on a blocked clinic with a recent analysis', async () => {
      inventoryReady();
      deps.quotaService.getQuota.mockResolvedValue({ allowed: false });
      deps.analysisRepository.findLatest.mockResolvedValue({
        content: { sections: [], disclaimer: 'D' },
        model: 'gpt-4o-mini',
        generatedAt: new Date(),
        periodStart: null,
        periodEnd: null,
      });

      const result = await service.getLatestInventory(USER, CLINIC);

      expect(result.visibility).toBe('TEASER');
      expect(openai.chat.completions.create).not.toHaveBeenCalled();
    });
  });

  // ── Health ping ────────────────────────────────────────────────────────────

  describe('pingOpenAi', () => {
    it('reports success and how long the round trip took', async () => {
      openai.chat.completions.create.mockResolvedValue(VALID_COMPLETION);

      const result = await service.pingOpenAi();

      expect(result.ok).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('spends almost nothing — a ten-token ceiling', async () => {
      openai.chat.completions.create.mockResolvedValue(VALID_COMPLETION);

      await service.pingOpenAi();

      expect(openai.chat.completions.create.mock.calls[0][0].max_tokens).toBe(
        10,
      );
    });

    it('reports a failure without throwing', async () => {
      openai.chat.completions.create.mockRejectedValue(
        new Error('unreachable'),
      );

      const result = await service.pingOpenAi();
      expect(result.ok).toBe(false);
    });
  });
});
